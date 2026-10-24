import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isValidUserId, type RequestContext } from "@pi-gateway/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { GatewayModels } from "../agent/runtime.js";
import { SessionTranscriptMissingError } from "../agent/session-factory.js";
import type { AuthResult, Authenticator } from "../auth/auth.js";
import type { GatewayConfig } from "../config.js";
import type { PluginResources, PromptService } from "../contracts.js";
import { ApiError, apiError, badRequest, conflict, notFound, shuttingDownError } from "../errors.js";
import type { SessionHub, LiveSession } from "../sessions/hub.js";
import type { TurnLimiter } from "../sessions/limiter.js";
import type { SessionRecord, SessionStore } from "../sessions/store.js";
import { emptyUsage, functionCallItem, ResponseEventMapper } from "./mapper.js";
import { type ParsedInput, parseInput, parseRequest, parseResponseId, type ResponseCreateRequest, responseId, thinkingLevelFor } from "./request.js";
import { SseWriter } from "./sse.js";
import { executeTurn, rewindTurn, type TurnOutcome } from "./turn.js";

/**
 * POST /v1/responses — OpenAI Responses 호환 (oh-my-gateway 계약).
 * 세션 id·turn 규칙, SSE 이벤트, AskUserQuestion은 README.md의 `/v1/responses` 절을 따른다.
 */

export interface ResponsesDeps {
  config: GatewayConfig;
  store: SessionStore;
  hub: SessionHub;
  limiter: TurnLimiter;
  auth: Authenticator;
  models: GatewayModels;
  prompts: PromptService;
  plugins: PluginResources;
  log: Logger;
}

/** cancel 요청으로 멈춘 턴의 abort reason. 연결 끊김·종료·시간 초과와 구분한다. */
const USER_CANCELLED = "user_cancelled";

const notFoundSession = (prev: string) => notFound(`Session for previous_response_id '${prev}' not found or expired`);

function requestContext(headers: IncomingHttpHeaders, metadata: Record<string, string> | null | undefined, config: GatewayConfig): RequestContext {
  const ctx: RequestContext = {};
  const forwarded: Record<string, string> = {};
  for (const name of config.mcp.forwardHeaders) {
    const v = headers[name];
    if (v === undefined) continue;
    forwarded[name] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (Object.keys(forwarded).length > 0) ctx.headers = forwarded;
  if (metadata) {
    const picked: Record<string, string> = {};
    for (const key of config.mcp.metadataKeys) if (typeof metadata[key] === "string") picked[key] = metadata[key];
    if (Object.keys(picked).length > 0) ctx.metadata = picked;
  }
  return ctx;
}

interface TurnPlan {
  sessionId: string;
  isNew: boolean;
  principal: string;
  user: string;
  prev: string | null;
  prevTurn: number;
  body: ResponseCreateRequest;
  input: ParsedInput;
  model: string;
  thinkingLevel: string | undefined;
}

export function registerResponsesRoutes(app: FastifyInstance, deps: ResponsesDeps): void {
  app.post("/v1/responses", async (req, reply) => {
    return createResponse(deps, req, reply, deps.auth.authenticate(req.headers.authorization));
  });

  app.get("/v1/models", async (req) => {
    deps.auth.authenticate(req.headers.authorization);
    return {
      object: "list",
      data: deps.models.list().map((m) => ({ id: m.id, object: "model", owned_by: deps.models.providerId })),
    };
  });

  app.post("/v1/responses/:id/cancel", async (req) => cancelResponse(deps, req, deps.auth.authenticate(req.headers.authorization)));
}

/**
 * 진행 중인 응답을 멈춘다 (`POST …/{id}/cancel?user=`). 그때까지의 내용은 남기고 `incomplete`(user_cancelled)로 끝나며,
 * 그 응답 id로 다음 턴을 이어갈 수 있다. 원래 요청의 연결이 끊긴 경우는 지금처럼 버린다.
 */
export function cancelResponse(deps: ResponsesDeps, req: FastifyRequest, auth: AuthResult): unknown {
  const { id } = req.params as { id: string };
  const user = userOf(auth, (req.query as { user?: string }).user);
  const parsed = parseResponseId(id);
  const record = parsed ? deps.store.get(parsed.sessionId) : undefined;
  if (!parsed || !record || record.principal !== user) throw notFound(`Response '${id}' not found`);
  const active = deps.hub.get(record.id)?.activeTurn;
  if (!active || parsed.turn !== record.turn + 1) {
    if (parsed.turn <= record.turn) {
      throw apiError(409, `Response '${id}' is no longer in progress.`, { type: "invalid_request_error", code: "response_not_cancellable" });
    }
    throw notFound(`Response '${id}' not found`);
  }
  active.abort(USER_CANCELLED);
  return { id, object: "response", status: "cancelling" };
}

/**
 * POST /v1/responses 처리. 인증은 호출하는 쪽이 한다 (API 키, 또는 관리 화면 채팅은 관리자 로그인).
 * 서비스 키·관리자는 body.user를 믿는다.
 */
export async function createResponse(deps: ResponsesDeps, req: FastifyRequest, reply: FastifyReply, auth: AuthResult): Promise<unknown> {
  if (deps.hub.isShuttingDown) throw shuttingDownError();
  const body = parseRequest(req.body);
  if (body.background) throw badRequest("background=true is not supported by this gateway");
  const format = body.text?.format?.type;
  if (format && format !== "text") throw badRequest(`text.format '${format}' is not supported yet`);
  const input = parseInput(body);

  const user = userOf(auth, body.user);

  const prev = body.previous_response_id ?? null;
  let sessionId: string;
  let prevTurn = 0;
  if (prev) {
    if (body.instructions) {
      throw badRequest("instructions cannot be used with previous_response_id. The system prompt is fixed to the original session.");
    }
    if (input.kind === "prompt" && input.hasSystemItems) {
      throw badRequest(
        "system/developer input items cannot be used with previous_response_id. The system prompt is fixed to the original session.",
      );
    }
    const parsed = parseResponseId(prev);
    if (!parsed) throw notFound(`previous_response_id '${prev}' is invalid`);
    sessionId = parsed.sessionId;
    prevTurn = parsed.turn;
  } else {
    if (input.kind === "answer") throw badRequest("function_call_output requires previous_response_id");
    sessionId = randomUUID();
  }
  const principal = user;

  // lock 밖에서 먼저 확인한다 (다른 사용자의 세션이면 기다리지 않고 바로 404).
  if (prev) {
    const record = deps.store.get(sessionId);
    if (!record || record.principal !== principal) throw notFoundSession(prev);
    if (prevTurn > record.turn) throw notFound(`previous_response_id '${prev}' references a future turn`);
  }

  const defaultModel = deps.models.defaultModel();
  if (!defaultModel) throw apiError(503, "LLM is not configured. Set it on the LLM page of the admin UI.", { type: "server_error", code: "llm_not_configured" });
  const model = body.model ?? defaultModel;
  const modelConfig = deps.models.config(model);
  if (!modelConfig) throw badRequest(`Model '${model}' is not supported. Available: ${deps.models.list().map((m) => m.id).join(", ")}`);
  const thinkingLevel = thinkingLevelFor(body.reasoning?.effort, modelConfig.reasoning);

  const plan: TurnPlan = { sessionId, isNew: !prev, principal, user, prev, prevTurn, body, input, model, thinkingLevel };

  // 클라이언트가 연결을 끊으면 실행을 멈춘다.
  const abort = new AbortController();
  let finished = false;
  reply.raw.on("close", () => {
    if (!finished) abort.abort();
  });

  let release: () => void;
  try {
    release = await deps.limiter.acquire(principal, abort.signal);
  } catch (err) {
    // 기다리는 중에 클라이언트가 떠났다. 응답을 받을 곳이 없다.
    if (abort.signal.aborted) return reply.code(499).send();
    throw err;
  }
  try {
    // 기다리는 동안 종료가 시작됐을 수 있다.
    if (deps.hub.isShuttingDown) throw shuttingDownError();
    return await deps.hub.locks.run(sessionId, () => {
      if (deps.hub.isShuttingDown) throw shuttingDownError();
      return runLocked(deps, req, reply, plan, abort);
    });
  } finally {
    finished = true;
    release();
  }
}

/** user 키면 키의 사용자, 서비스 키면 클라이언트가 보낸 user */
function userOf(auth: AuthResult, claimed: string | null | undefined): string {
  if (auth.kind === "user") return auth.user;
  if (!claimed) throw badRequest("user is required");
  if (!isValidUserId(claimed)) throw badRequest(`Invalid user '${claimed}'`);
  return claimed;
}

function newRecord(deps: ResponsesDeps, plan: TurnPlan): SessionRecord {
  const now = new Date();
  const snapshot = deps.prompts.snapshotForSession({
    principal: plan.principal,
    user: plan.user,
    model: plan.model,
    sessionId: plan.sessionId,
    now,
  });
  const instructions = plan.body.instructions ?? (plan.input.kind === "prompt" ? plan.input.systemText : null);
  const append: string[] = [];
  if (instructions?.trim()) append.push(instructions.trim());
  append.push(`Current user: ${plan.user}`);
  const reasoning = deps.models.config(plan.model)?.reasoning ?? false;
  const iso = now.toISOString();
  return {
    id: plan.sessionId,
    principal: plan.principal,
    user: plan.user,
    model: plan.model,
    thinkingLevel: plan.thinkingLevel ?? (reasoning ? "medium" : "off"),
    turn: 0,
    sessionFile: null,
    leafId: null,
    promptText: snapshot.text,
    promptRef: snapshot.ref,
    appendPrompt: append.join("\n\n"),
    skillNames: deps.plugins.skills().map((s) => s.name),
    pendingToolCall: null,
    createdAt: iso,
    updatedAt: iso,
    lastActiveAt: iso,
  };
}

function requireImageInput(deps: ResponsesDeps, model: string, input: ParsedInput): void {
  if (input.kind === "prompt" && input.images.length > 0 && !deps.models.config(model)?.input.includes("image")) {
    throw badRequest(`Model '${model}' does not accept image input`, "unsupported_image_input");
  }
}

async function runLocked(
  deps: ResponsesDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  plan: TurnPlan,
  abort: AbortController,
): Promise<unknown> {
  let record: SessionRecord;
  if (plan.isNew) {
    requireImageInput(deps, plan.model, plan.input);
    record = newRecord(deps, plan);
    deps.store.insert(record);
  } else {
    const found = deps.store.get(plan.sessionId);
    if (!found || found.principal !== plan.principal) throw notFoundSession(plan.prev!);
    record = found;
    if (!deps.models.config(record.model)) {
      throw badRequest(`This session's model '${record.model}' is no longer configured. Start a new conversation.`, "model_not_configured");
    }
    requireImageInput(deps, record.model, plan.input);
    if (plan.prevTurn < record.turn) {
      throw conflict(
        `Stale previous_response_id: only the latest response (${responseId(record.id, record.turn)}) can be continued`,
      );
    }
    if (plan.prevTurn > record.turn) throw notFound(`previous_response_id '${plan.prev}' references a future turn`);
    if (plan.thinkingLevel && plan.thinkingLevel !== record.thinkingLevel) {
      throw badRequest("reasoning.effort is fixed when the session is created");
    }
  }

  const pending = record.pendingToolCall;
  if (pending) {
    if (plan.input.kind === "prompt") {
      throw conflict(
        `This session is waiting for the user's decision on ${pending.name} (call_id '${pending.call_id}'). ` +
          "Answer it with a function_call_output before sending another turn.",
      );
    }
    if (plan.input.callId !== pending.call_id) {
      throw badRequest(`call_id mismatch: pending tool call has '${pending.call_id}', but received '${plan.input.callId}'`);
    }
  } else if (plan.input.kind === "answer") {
    throw badRequest("function_call_output received but no pending tool call in session");
  }

  let live: LiveSession;
  try {
    live = await deps.hub.acquire(record, abort.signal, requestContext(req.headers, plan.body.metadata, deps.config));
  } catch (err) {
    if (plan.isNew) await deps.hub.discardLocked(record.id);
    if (err instanceof SessionTranscriptMissingError) {
      await deps.hub.discardLocked(record.id);
      throw notFoundSession(plan.prev!);
    }
    if (err instanceof ApiError) throw err;
    deps.log.error({ err, session: record.id }, "failed to open session");
    throw apiError(503, "Session could not be started; retry shortly");
  }
  live.activeTurn = abort;
  live.lastActive = Date.now();
  // 만료 정리가 진행 중인 턴의 세션을 지우지 않도록 활동 시각을 먼저 남긴다.
  deps.store.touch(record.id);

  const turn = record.turn + 1;
  const respId = responseId(record.id, turn);
  const text = plan.input.kind === "answer" ? `User responded: ${plan.input.output}` : plan.input.text;
  const images = plan.input.kind === "prompt" ? plan.input.images : [];
  const expandTemplates = plan.input.kind === "prompt";
  const metadata = plan.body.metadata ?? {};
  const createdAt = Math.floor(Date.now() / 1000);
  const base = { id: respId, object: "response", created_at: createdAt, model: record.model };
  const log = deps.log.child({ session: record.id, turn });
  const leafBefore = live.agent.session.sessionManager.getLeafId();

  /** 턴을 실행한다. 예상하지 못한 예외도 실패 결과로 바꿔서 commit/rewind가 항상 일어나게 한다. */
  const run = async (mapper: ResponseEventMapper): Promise<TurnOutcome> => {
    try {
      const outcome = await executeTurn({ live, text, images, expandTemplates, mapper, signal: abort.signal, log });
      if (outcome.status === "aborted" && abort.signal.reason === USER_CANCELLED) {
        return { ...outcome, status: "incomplete", incompleteReason: "user_cancelled" };
      }
      return outcome;
    } catch (err) {
      log.error({ err }, "turn crashed");
      return { status: "failed", error: { code: "server_error", message: "Internal server error" }, leafBefore };
    }
  };

  const finish = async (outcome: TurnOutcome): Promise<void> => {
    live.activeTurn = null;
    live.lastActive = Date.now();
    const sm = live.agent.session.sessionManager;
    if (outcome.status === "completed" || outcome.status === "incomplete" || outcome.status === "requires_action") {
      deps.store.commit(record.id, {
        turn,
        leafId: sm.getLeafId(),
        sessionFile: sm.getSessionFile() ?? null,
        pendingToolCall: outcome.pending ?? null,
      });
      live.record = deps.store.get(record.id) ?? live.record;
      return;
    }
    // 실패·중단된 턴은 commit하지 않고, 대화 기록에서도 지운다 (같은 previous_response_id로 다시 시도할 수 있다).
    if (plan.isNew) {
      await deps.hub.discardLocked(record.id);
      return;
    }
    try {
      rewindTurn(live, outcome.leafBefore);
    } catch (err) {
      log.warn({ err }, "rewind failed; evicting session");
      await deps.hub.discardLive(record.id);
    }
    const file = sm.getSessionFile();
    if (file) deps.store.setSessionFile(record.id, file);
  };

  if (plan.body.stream) {
    reply.hijack();
    const sse = new SseWriter(reply.raw);
    sse.start();
    const mapper = new ResponseEventMapper((type, payload) => sse.send(type, payload));
    try {
      await streamTurn();
    } catch (err) {
      // hijack 이후라 Fastify 오류 처리기를 쓸 수 없다. 스트림 안에서 실패로 끝낸다.
      log.error({ err }, "stream turn crashed");
      sse.send("response.failed", {
        response: { ...base, status: "failed", output: [], usage: emptyUsage(), metadata, error: { code: "server_error", message: "Internal server error" } },
      });
    } finally {
      sse.end();
    }
    return reply;

    async function streamTurn(): Promise<void> {
      const inProgress = { ...base, status: "in_progress", output: [], usage: emptyUsage(), metadata };
      sse.send("response.created", { response: inProgress });
      sse.send("response.in_progress", { response: inProgress });
      sse.startKeepalive(deps.config.sse.keepaliveSeconds * 1000, () => mapper.heartbeat());
      const outcome = await run(mapper);
      sse.stopKeepalive();
      await finish(outcome);
      switch (outcome.status) {
        case "completed":
        case "incomplete":
          mapper.finalize(outcome.status);
          sse.send(outcome.status === "completed" ? "response.completed" : "response.incomplete", {
            response: {
              ...base,
              status: outcome.status,
              output: mapper.items,
              usage: mapper.usage(),
              metadata,
              ...(outcome.incompleteReason ? { incomplete_details: { reason: outcome.incompleteReason } } : {}),
            },
          });
          break;
        case "requires_action": {
          mapper.closeOpenItems();
          const item = functionCallItem(outcome.pending!);
          sse.send("response.output_item.added", { response_id: respId, item });
          sse.send("response.completed", {
            response: { ...base, status: "requires_action", output: [item], usage: mapper.usage(), metadata },
          });
          break;
        }
        case "failed":
          mapper.closeOpenItems("incomplete");
          sse.send("response.failed", {
            response: { ...base, status: "failed", output: [], usage: emptyUsage(), metadata, error: outcome.error },
          });
          break;
        case "aborted":
          // 보통은 클라이언트가 연결을 끊은 경우라 보낼 곳이 없다.
          // gateway 종료로 중단됐고 연결이 살아 있으면 실패로 알린다.
          if (!sse.isClosed) {
            mapper.closeOpenItems("incomplete");
            sse.send("response.failed", {
              response: {
                ...base,
                status: "failed",
                output: [],
                usage: emptyUsage(),
                metadata,
                error: { code: "server_error", message: deps.hub.isShuttingDown ? "Gateway is shutting down" : "Turn was interrupted" },
              },
            });
          }
          break;
      }
    }
  }

  // 비스트리밍
  const mapper = new ResponseEventMapper(null);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, deps.config.sessions.nonStreamTimeoutSeconds * 1000);
  const outcome = await run(mapper);
  clearTimeout(timer);
  await finish(outcome);
  if (timedOut) throw apiError(504, `Non-streaming turn timed out after ${deps.config.sessions.nonStreamTimeoutSeconds}s`);
  const full = (status: string, output: unknown[], extra: Record<string, unknown> = {}) => ({
    ...base,
    status,
    output,
    usage: mapper.usage(),
    metadata,
    error: null,
    incomplete_details: null,
    structured_output: null,
    background: null,
    ...extra,
  });
  switch (outcome.status) {
    case "completed":
      mapper.finalize("completed");
      return reply.send(full("completed", mapper.nonStreamOutput()));
    case "incomplete":
      mapper.finalize("incomplete");
      return reply.send(full("incomplete", mapper.nonStreamOutput(), { incomplete_details: { reason: outcome.incompleteReason } }));
    case "requires_action":
      return reply.send(full("requires_action", [functionCallItem(outcome.pending!)]));
    case "failed":
      if (outcome.error?.code === "rate_limit") throw apiError(429, `Backend error: ${outcome.error.message}`);
      throw apiError(502, `Backend error: ${outcome.error?.message ?? "unknown error"}`);
    case "aborted":
      // 클라이언트가 연결을 끊었다 (nginx 관례의 499). 실제로 전달되지는 않는다.
      return reply.code(499).send();
  }
}
