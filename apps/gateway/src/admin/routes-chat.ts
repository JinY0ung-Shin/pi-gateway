import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";

/** 관리 화면 채팅. 본문은 `/v1/responses`와 같고, 관리자 로그인이 API 키를 대신한다. */
export function registerChatRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { config, llm } = ctx.deps;
  /** 채팅 화면이 고를 수 있는 값 */
  app.get("/chat/options", async () => ({
    models: llm.list().map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: m.reasoning, image: m.input.includes("image") })),
    defaultModel: llm.defaultModel() ?? null,
    /** MCP 템플릿 {{ctx.header:NAME}}로 넘어가는 헤더. 채팅 화면이 요청 헤더로 보낸다. */
    forwardHeaders: config.mcp.forwardHeaders,
    /** MCP 템플릿 {{metadata:KEY}}로 넘어가는 metadata 키 */
    metadataKeys: config.mcp.metadataKeys,
  }));
  app.post("/chat", async (req, reply) => ctx.deps.chat.respond(req, reply));
  app.post("/chat/:id/cancel", async (req, reply) => ctx.deps.chat.cancel(req, reply));
}
