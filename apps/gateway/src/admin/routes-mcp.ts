import type { FastifyInstance } from "fastify";
import { badRequest } from "./errors.js";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";

type IdParams = { Params: { id: string } };
type SecretParams = { Params: { id: string; name: string } };

export function registerMcpRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { mcp } = ctx;

  app.get("/mcp/servers", async () => mcp.list());

  app.post<{ Body: { config?: unknown } }>("/mcp/validate", async (req) => mcp.validate(req.body?.config));

  app.put<IdParams & { Body: { config?: unknown } }>("/mcp/servers/:id", async (req) => {
    const raw = req.body?.config as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("body must be an MCP server config object");
    if (raw.id !== undefined && raw.id !== req.params.id) throw badRequest("config.id must match the URL");
    return mcp.upsert({ ...raw, id: req.params.id }, actorOf(req));
  });

  app.delete<IdParams>("/mcp/servers/:id", async (req, reply) => {
    await mcp.remove(req.params.id, actorOf(req));
    return reply.code(204).send();
  });

  // 비밀값은 쓰기 전용: 응답·로그 어디에도 값을 넣지 않는다.
  app.put<SecretParams & { Body: unknown }>("/mcp/servers/:id/secrets/:name", async (req, reply) => {
    await mcp.setSecret(req.params.id, req.params.name, req.body, actorOf(req));
    return reply.code(204).send();
  });

  app.delete<SecretParams>("/mcp/servers/:id/secrets/:name", async (req, reply) => {
    await mcp.deleteSecret(req.params.id, req.params.name, actorOf(req));
    return reply.code(204).send();
  });

  app.post<IdParams>("/mcp/servers/:id/test", async (req) => mcp.test(req.params.id, actorOf(req)));
}
