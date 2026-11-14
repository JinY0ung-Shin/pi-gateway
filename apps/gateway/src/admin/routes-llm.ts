import type { FastifyInstance } from "fastify";
import { LlmServer, LlmSettings, type LlmSettingsRecord, probeLlmServer, testLlmModel } from "../agent/runtime.js";
import type { AdminContext } from "./context.js";
import { PlatformError, parseBody } from "./errors.js";

/** 응답에 넣는 모양: API 키 대신 키가 있는지만 (routes-systemone도 쓴다) */
export function hideKey<T extends { apiKey: string }>({ apiKey, ...rest }: T): Omit<T, "apiKey"> & { apiKeySet: boolean } {
  return { ...rest, apiKeySet: apiKey !== "" };
}

/** apiKey를 빼고 보낸 설정에 저장된 키(없으면 "")를 넣는다. 객체가 아니면 그대로 둔다 (검증이 거절한다). */
export function withStoredKey(input: unknown, stored: (input: Record<string, unknown>) => string | undefined): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const s = input as Record<string, unknown>;
  return s.apiKey !== undefined ? s : { ...s, apiKey: stored(s) ?? "" };
}

/**
 * LLM 연결 설정 (서버마다 API 형식, 주소, 키, 헤더, compat, 모델 목록 / 기본 모델 / 티어). 저장하면 바로 적용된다.
 * API 키는 돌려주지 않는다. 서버에서 apiKey를 빼면 같은 id로 저장된 키를 그대로 쓰고, ""이면 키를 지운다.
 * probe·test도 같은 규칙으로 저장된 키를 쓴다 (저장하기 전 설정으로 확인할 수 있다).
 */
export function registerLlmRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { llm } = ctx;

  const view = (record: LlmSettingsRecord | null) => {
    if (!record) return { configured: false, settings: null, updatedAt: null };
    const { servers, defaultModel, tiers } = record.settings;
    return {
      configured: true,
      settings: { servers: servers.map(hideKey), defaultModel, tiers },
      updatedAt: record.updatedAt,
    };
  };

  const storedKey = (server: unknown) => withStoredKey(server, (s) => llm.current()?.settings.servers.find((x) => x.id === s.id)?.apiKey);

  app.get("/llm", async () => view(llm.current()));

  app.put<{ Body: Record<string, unknown> | null }>("/llm", async (req) => {
    const body = req.body ?? {};
    const servers = Array.isArray(body.servers) ? body.servers.map(storedKey) : body.servers;
    const settings = parseBody(LlmSettings, { ...body, servers }, { code: "invalid_llm_settings" });
    let record: LlmSettingsRecord;
    try {
      record = await llm.update(settings);
    } catch (err) {
      throw new PlatformError(400, "llm_register_failed", err instanceof Error ? err.message : String(err));
    }
    ctx.log.info(
      { servers: record.settings.servers.map((s) => ({ id: s.id, baseUrl: s.baseUrl, models: s.models.map((m) => m.id) })), tiers: record.settings.tiers },
      "llm settings updated",
    );
    return view(record);
  });

  /** 서버의 모델 목록 (연결·인증 확인 겸) */
  app.post<{ Body: { server?: unknown } | null }>("/llm/probe", async (req) => {
    const server = parseBody(LlmServer.pick({ api: true, baseUrl: true, apiKey: true, headers: true }), storedKey(req.body?.server), { code: "invalid_llm_server" });
    return probeLlmServer(server);
  });

  /** 모델 하나에 짧은 요청을 보낸다 */
  app.post<{ Body: { server?: unknown; model?: unknown } | null }>("/llm/test", async (req) => {
    const server = parseBody(LlmServer, storedKey(req.body?.server), { code: "invalid_llm_server" });
    const model = req.body?.model;
    if (typeof model !== "string" || !server.models.some((m) => m.id === model)) {
      throw new PlatformError(400, "invalid_llm_server", "model must be one of the server's models");
    }
    return testLlmModel(server, model);
  });
}
