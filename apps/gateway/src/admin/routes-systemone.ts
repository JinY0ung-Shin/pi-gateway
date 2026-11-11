import type { FastifyInstance } from "fastify";
import { SystemOneModel, type SystemOneRecord, testSystemOne } from "../agent/runtime.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

/**
 * System One 설정 (mcp_search가 쓰는 decision model 서버: 주소, 키, 헤더, 모델 id). 저장하면 바로 적용된다.
 * API 키는 돌려주지 않는다. apiKey를 빼면 저장된 키를 그대로 쓰고, ""이면 키를 지운다. test도 같은 규칙이라
 * 저장하기 전 설정으로 확인할 수 있다.
 */
export function registerSystemOneRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { llm } = ctx;

  const view = (record: SystemOneRecord | null) => {
    if (!record) return { model: null, updatedAt: null };
    const { apiKey, ...model } = record.model;
    return { model: { ...model, apiKeySet: apiKey !== "" }, updatedAt: record.updatedAt };
  };

  const parse = (input: unknown): SystemOneModel => {
    const withKey =
      typeof input === "object" && input !== null && !Array.isArray(input) && (input as { apiKey?: unknown }).apiKey === undefined
        ? { ...input, apiKey: llm.systemOne()?.model.apiKey ?? "" }
        : input;
    const parsed = SystemOneModel.safeParse(withKey);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new PlatformError(400, "invalid_systemone_model", issues.map((i) => `${i.path || "model"}: ${i.message}`).join("; "), issues);
  };

  app.get("/systemone", async () => view(llm.systemOne()));

  /** model이 null이면 설정을 지운다 */
  app.put<{ Body: { model?: unknown } | null }>("/systemone", async (req) => {
    const input = req.body?.model;
    const model = input === null || input === undefined ? null : parse(input);
    let record: SystemOneRecord | null;
    try {
      record = await llm.setSystemOne(model);
    } catch (err) {
      throw new PlatformError(400, "systemone_register_failed", err instanceof Error ? err.message : String(err));
    }
    ctx.log.info({ model: record && { baseUrl: record.model.baseUrl, id: record.model.id } }, "system one settings updated");
    return view(record);
  });

  /** 짧은 choice 질문 하나를 보낸다 */
  app.post<{ Body: { model?: unknown } | null }>("/systemone/test", async (req) => testSystemOne(parse(req.body?.model)));
}
