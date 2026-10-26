import type { FastifyInstance } from "fastify";
import { LlmSettings, type LlmSettingsRecord } from "../agent/runtime.js";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

/**
 * LLM 연결 설정 (API 형식, 주소, 키, 모델 목록, 기본 모델, 헤더, compat). 저장하면 바로 적용된다.
 * API 키는 돌려주지 않는다. PUT에서 apiKey를 빼면 지금 키를 그대로 쓰고, ""이면 키를 지운다.
 */
export function registerLlmRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { llm } = ctx;

  const view = (record: LlmSettingsRecord | null) => {
    if (!record) return { configured: false, settings: null, apiKeySet: false, updatedAt: null, updatedBy: null };
    const { apiKey, ...settings } = record.settings;
    return { configured: true, settings, apiKeySet: apiKey !== "", updatedAt: record.updatedAt, updatedBy: record.updatedBy };
  };

  app.get("/llm", async () => view(llm.current()));

  app.put<{ Body: Record<string, unknown> | null }>("/llm", async (req) => {
    const body = req.body ?? {};
    const apiKey = body.apiKey === undefined ? (llm.current()?.settings.apiKey ?? "") : body.apiKey;
    const parsed = LlmSettings.safeParse({ ...body, apiKey });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      throw new PlatformError(400, "invalid_llm_settings", issues.map((i) => `${i.path || "body"}: ${i.message}`).join("; "), issues);
    }
    const actor = actorOf(req);
    let record: LlmSettingsRecord;
    try {
      record = await llm.update(parsed.data, actor);
    } catch (err) {
      throw new PlatformError(400, "llm_register_failed", err instanceof Error ? err.message : String(err));
    }
    ctx.log.info({ actor, baseUrl: record.settings.baseUrl, models: record.settings.models.map((m) => m.id) }, "llm settings updated");
    return view(record);
  });
}
