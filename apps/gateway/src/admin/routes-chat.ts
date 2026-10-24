import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";

/** 관리 화면 채팅. 본문은 `/v1/responses`와 같고, 관리자 로그인이 API 키를 대신한다. */
export function registerChatRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.post("/chat", async (req, reply) => ctx.deps.chat(req, reply));
}
