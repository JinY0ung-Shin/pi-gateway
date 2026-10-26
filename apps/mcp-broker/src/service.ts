import { createHash, randomUUID } from "node:crypto";
import type { CallToolResult, Progress, Tool } from "@modelcontextprotocol/client";
import { ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  isToolAllowed,
  type McpServerView,
  type TestServerResponse,
  type ToolSummary,
  type VisibleServer,
} from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { BrokerConfig } from "./config.js";
import { type Lease, PoolCapacityError, type UpstreamPool, UpstreamBackoffError } from "./pool.js";
import { describeError, Redactor } from "./redact.js";
import {
  ConfigError,
  effectiveScope,
  type Identity,
  MissingSessionError,
  type RenderResult,
  renderTransport,
  scopeKey,
} from "./render.js";
import type { BrokerStore, StoredServer } from "./store.js";
import { connectUpstream } from "./upstream/connect.js";

/** 서버가 없거나, 꺼져 있거나, 필요한 비밀키가 없다. 데이터 평면에서는 404로 답한다. */
export class ServerUnavailableError extends Error {
  override name = "ServerUnavailableError";
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

interface Prepared {
  server: StoredServer;
  rendered: RenderResult;
  redactor: Redactor;
  key: { scopeKey: string; renderedHash: string };
}

type FailureKind = "timeout" | "cancelled" | "unavailable" | "busy" | "rejected" | "error";

const correlationId = () => randomUUID().slice(0, 8);

export class BrokerService {
  readonly #store: BrokerStore;
  readonly #pool: UpstreamPool;
  readonly #config: BrokerConfig;
  readonly #log: Logger;
  readonly #lastErrors = new Map<string, { message: string; at: string }>();

  constructor(deps: { store: BrokerStore; pool: UpstreamPool; config: BrokerConfig; log: Logger }) {
    this.#store = deps.store;
    this.#pool = deps.pool;
    this.#config = deps.config;
    this.#log = deps.log;
  }

  // ── 조회 ──────────────────────────────────────────────────────────

  #effectiveTimeoutSec(server: StoredServer): number {
    return Math.min(server.config.timeoutSec, this.#config.limits.callTimeoutCapSeconds);
  }

  /** enabled이고 필요한 비밀키가 모두 있는 서버 */
  #usable(serverId: string): StoredServer {
    const server = this.#store.getServer(serverId);
    if (!server || !server.config.enabled || this.#store.missingSecrets(server).length > 0) {
      throw new ServerUnavailableError(`MCP server '${serverId}' is not available`);
    }
    return server;
  }

  isUsable(serverId: string): boolean {
    try {
      this.#usable(serverId);
      return true;
    } catch {
      return false;
    }
  }

  visibleServers(_identity: Identity): VisibleServer[] {
    const out: VisibleServer[] = [];
    for (const server of this.#store.listServers()) {
      if (!server.config.enabled || this.#store.missingSecrets(server).length > 0) continue;
      const view: VisibleServer = { id: server.config.id, timeoutSec: this.#effectiveTimeoutSec(server) };
      if (server.config.displayName) view.displayName = server.config.displayName;
      if (server.config.description) view.description = server.config.description;
      out.push(view);
    }
    return out;
  }

  serverView(server: StoredServer): McpServerView {
    const view: McpServerView = {
      config: server.config,
      secrets: this.#store.listSecretMeta(server.config.id).map(({ name, setAt, fingerprint }) => ({ name, setAt, fingerprint })),
      missingSecrets: this.#store.missingSecrets(server),
    };
    const last = this.#lastErrors.get(server.config.id);
    if (last) view.status = { lastError: last.message, lastErrorAt: last.at };
    return view;
  }

  forgetServer(serverId: string): void {
    this.#lastErrors.delete(serverId);
    this.#pool.retireServer(serverId);
  }

  // ── 연결 준비 ─────────────────────────────────────────────────────

  #prepare(server: StoredServer, identity: Identity): Prepared {
    const { values, failed } = this.#store.resolveSecrets(server.config.id);
    if (failed.length > 0) {
      // KEK가 바뀌었거나 DB가 변조됐다. 값 없이 연결하면 안 된다.
      throw new ConfigError(`secrets could not be decrypted: ${failed.join(", ")}`);
    }
    const rendered = renderTransport(server.config, identity, values);
    if (rendered.missingSecrets.length > 0) {
      throw new ServerUnavailableError(`missing secrets: ${rendered.missingSecrets.join(", ")}`);
    }
    const redactor = new Redactor([...values.values(), ...rendered.credentials]);
    const renderedHash = createHash("sha256").update(JSON.stringify(rendered.transport)).digest("hex");
    return {
      server,
      rendered,
      redactor,
      key: { scopeKey: scopeKey(effectiveScope(server.config), identity), renderedHash },
    };
  }

  async #acquire(prepared: Prepared): Promise<Lease> {
    const { server, rendered, key } = prepared;
    return this.#pool.acquire({ serverId: server.config.id, revision: server.revision, ...key }, rendered.transport);
  }

  // ── 도구 ──────────────────────────────────────────────────────────

  async #fetchTools(lease: Lease, server: StoredServer, signal?: AbortSignal): Promise<Tool[]> {
    const cached = lease.cachedTools(this.#config.limits.toolsCacheSeconds * 1000);
    if (cached) return cached;
    const timeoutMs = this.#config.limits.connectTimeoutSeconds * 1000;
    const result = await lease.client.listTools(undefined, {
      timeout: timeoutMs,
      cacheMode: "bypass",
      ...(signal ? { signal } : {}),
    });
    lease.setTools(result.tools);
    this.#log.debug({ serverId: server.config.id, tools: result.tools.length }, "fetched upstream tools");
    return result.tools;
  }

  /** toolAllow/toolDeny로 거르고 가린 도구 목록. 실패하면 일반 메시지의 ProtocolError를 던진다. */
  async listTools(serverId: string, identity: Identity, signal?: AbortSignal): Promise<Tool[]> {
    const server = this.#usable(serverId);
    let prepared: Prepared | undefined;
    let lease: Lease | undefined;
    try {
      prepared = this.#prepare(server, identity);
      lease = await this.#acquire(prepared);
      const tools = await this.#fetchTools(lease, server, signal);
      return tools.filter((t) => isToolAllowed(server.config, t.name)).map((t) => prepared!.redactor.redactDeep(t));
    } catch (error) {
      const { message } = this.#fail(serverId, "tools/list", error, prepared?.redactor);
      throw new ProtocolError(ProtocolErrorCode.InternalError, message);
    } finally {
      lease?.release();
    }
  }

  async callTool(
    serverId: string,
    identity: Identity,
    params: { name: string; arguments?: Record<string, unknown> | undefined },
    options: CallOptions = {},
  ): Promise<CallToolResult> {
    const server = this.#usable(serverId);
    if (!isToolAllowed(server.config, params.name)) {
      return errorResult(`Tool '${params.name}' is not available on MCP server '${serverId}'`);
    }
    const timeoutSec = this.#effectiveTimeoutSec(server);
    const deadline = AbortSignal.timeout(timeoutSec * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    let prepared: Prepared | undefined;
    let lease: Lease | undefined;
    try {
      prepared = this.#prepare(server, identity);
      lease = await this.#acquire(prepared);
      const redactor = prepared.redactor;
      const onProgress = options.onProgress;
      const result = await lease.client.callTool(
        { name: params.name, arguments: params.arguments ?? {} },
        {
          signal,
          timeout: timeoutSec * 1000,
          maxTotalTimeout: timeoutSec * 1000,
          resetTimeoutOnProgress: true,
          // 출력 스키마 검증은 클라이언트(모델 쪽)가 한다. broker는 그대로 전달한다.
          toolDefinition: { name: params.name, inputSchema: { type: "object" } },
          ...(onProgress ? { onprogress: (p: Progress) => onProgress(redactor.redactDeep(p)) } : {}),
        },
      );
      return capResult(redactor.redactDeep(result), this.#config.limits.maxResultBytes);
    } catch (error) {
      const kind = classify(error, { deadline, caller: options.signal });
      const { message } = this.#fail(serverId, `tools/call ${params.name}`, error, prepared?.redactor, kind, timeoutSec);
      return errorResult(message);
    } finally {
      lease?.release();
    }
  }

  /** 오류를 기록하고(가린 상세는 로그에만) 모델에게 보여줄 일반 메시지를 만든다. */
  #fail(
    serverId: string,
    operation: string,
    error: unknown,
    redactor: Redactor | undefined,
    kind: FailureKind = classify(error, {}),
    timeoutSec?: number,
  ): { message: string; ref: string } {
    const ref = correlationId();
    const safe = redactor ?? new Redactor([]);
    this.#log.warn({ serverId, operation, ref, kind, err: describeError(error, safe) }, "upstream MCP failure");
    let message: string;
    switch (kind) {
      case "timeout":
        message = `Upstream MCP call timed out${timeoutSec ? ` after ${timeoutSec}s` : ""} (ref ${ref})`;
        break;
      case "cancelled":
        message = `Upstream MCP call was cancelled (ref ${ref})`;
        break;
      case "unavailable":
        message = `Upstream MCP server is unavailable (ref ${ref})`;
        break;
      case "busy":
        message = `Upstream MCP server is busy, try again later (ref ${ref})`;
        break;
      case "rejected": {
        // 인자 오류는 모델이 고칠 수 있도록 메시지를 (가려서) 전달한다.
        const detail = error instanceof Error ? safe.redact(error.message).slice(0, 300) : "invalid request";
        message = `Upstream MCP server rejected the call: ${detail} (ref ${ref})`;
        break;
      }
      default:
        message = `Upstream MCP server error (ref ${ref})`;
    }
    this.#lastErrors.set(serverId, { message, at: new Date().toISOString() });
    return { message, ref };
  }

  // ── 관리 ──────────────────────────────────────────────────────────

  /** 관리 화면의 도구 목록. 풀을 쓴다. 오류 상세(가린 것)를 그대로 돌려준다. */
  async adminTools(server: StoredServer, user: string | undefined): Promise<ToolSummary[]> {
    const identity: Identity = { sub: user ?? "_admin", sid: "admin" };
    const prepared = this.#prepare(server, identity);
    let lease: Lease | undefined;
    try {
      lease = await this.#acquire(prepared);
      const tools = await this.#fetchTools(lease, server);
      return tools.filter((t) => isToolAllowed(server.config, t.name)).map((t) => summarize(prepared.redactor.redactDeep(t)));
    } catch (error) {
      throw new AdminUpstreamError(describeError(error, prepared.redactor, 1000));
    } finally {
      lease?.release();
    }
  }

  /** 풀을 거치지 않는 새 연결로 연결·도구 목록을 확인한다. */
  async testServer(server: StoredServer, user: string | undefined): Promise<TestServerResponse> {
    const started = Date.now();
    const identity: Identity = { sub: user ?? "_admin", sid: `admin-test-${randomUUID()}` };
    let redactor = new Redactor([]);
    try {
      const missing = this.#store.missingSecrets(server);
      if (missing.length > 0) return { ok: false, error: `missing secrets: ${missing.join(", ")}`, durationMs: 0 };
      const prepared = this.#prepare(server, identity);
      redactor = prepared.redactor;
      const conn = await connectUpstream(prepared.rendered.transport, {
        connectTimeoutMs: this.#config.limits.connectTimeoutSeconds * 1000,
        hooks: { onClosed: () => {}, onToolsChanged: () => {} },
      });
      try {
        const { tools } = await conn.client.listTools(undefined, {
          timeout: this.#config.limits.connectTimeoutSeconds * 1000,
          cacheMode: "bypass",
        });
        return {
          ok: true,
          tools: tools.filter((t) => isToolAllowed(server.config, t.name)).map((t) => summarize(redactor.redactDeep(t))),
          durationMs: Date.now() - started,
        };
      } finally {
        await conn.close();
      }
    } catch (error) {
      return { ok: false, error: describeError(error, redactor, 1000), durationMs: Date.now() - started };
    }
  }
}

export class AdminUpstreamError extends Error {
  override name = "AdminUpstreamError";
}

function summarize(tool: Tool): ToolSummary {
  const out: ToolSummary = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.description) out.description = tool.description;
  return out;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function classify(error: unknown, signals: { deadline?: AbortSignal; caller?: AbortSignal | undefined }): FailureKind {
  if (signals.deadline?.aborted) return "timeout";
  if (signals.caller?.aborted) return "cancelled";
  if (error instanceof PoolCapacityError) return "busy";
  if (error instanceof UpstreamBackoffError || error instanceof ServerUnavailableError || error instanceof MissingSessionError) {
    return "unavailable";
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) return "timeout";
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected) return "unavailable";
  }
  if (error instanceof ProtocolError) {
    if (error.code === ProtocolErrorCode.InvalidParams || error.code === ProtocolErrorCode.MethodNotFound) return "rejected";
    return "error";
  }
  if (error instanceof Error && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(error.message)) {
    return "unavailable";
  }
  return "error";
}

/** 결과가 너무 크면 텍스트만 남겨 자른다. 표시는 앞에 둔다 (gateway가 긴 결과의 앞부분만 모델에 보여 주므로). */
export function capResult(result: CallToolResult, maxBytes: number): CallToolResult {
  const size = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size <= maxBytes) return result;
  const text = (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type} content omitted]`))
    .join("\n");
  const budget = Math.max(512, maxBytes - 512);
  const bytes = Buffer.from(text, "utf8");
  const truncated = bytes.length > budget ? bytes.subarray(0, budget).toString("utf8").replace(/�$/, "") : text;
  return {
    content: [
      {
        type: "text",
        text: `[mcp-broker: result truncated — ${size} bytes exceeds the ${maxBytes}-byte limit]\n\n${truncated}`,
      },
    ],
    isError: result.isError ?? false,
  };
}
