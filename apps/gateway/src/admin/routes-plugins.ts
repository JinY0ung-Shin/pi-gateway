import type { FastifyInstance } from "fastify";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";

type NameParams = { Params: { name: string } };
type IdParams = { Params: { id: string } };

export function registerPluginRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { plugins } = ctx;

  // ── marketplace ──
  app.get("/marketplaces", async () => ({ marketplaces: plugins.listMarketplaces() }));

  app.post<{ Body: unknown }>("/marketplaces", async (req, reply) => {
    const created = await plugins.addMarketplace(req.body, actorOf(req));
    return reply.code(201).send(created);
  });

  app.get<NameParams>("/marketplaces/:name", async (req) => plugins.getMarketplace(req.params.name));

  app.post<NameParams & { Body: unknown }>("/marketplaces/:name/refresh", async (req) =>
    plugins.refreshMarketplace(req.params.name, req.body, actorOf(req)),
  );

  app.delete<NameParams>("/marketplaces/:name", async (req, reply) => {
    await plugins.removeMarketplace(req.params.name, actorOf(req));
    return reply.code(204).send();
  });

  // ── 설치된 plugin ──
  app.get("/plugins", async () => ({ plugins: plugins.listPlugins() }));

  app.post<{ Body: unknown }>("/plugins/install", async (req, reply) => {
    const result = await plugins.install(req.body, actorOf(req));
    return reply.code(201).send(result);
  });

  app.get<IdParams>("/plugins/:id", async (req) => plugins.getPlugin(req.params.id));

  app.post<IdParams & { Body: unknown }>("/plugins/:id/update", async (req) => plugins.update(req.params.id, req.body, actorOf(req)));

  app.post<IdParams>("/plugins/:id/enable", async (req) => plugins.setEnabled(req.params.id, true, actorOf(req)));

  app.post<IdParams>("/plugins/:id/disable", async (req) => plugins.setEnabled(req.params.id, false, actorOf(req)));

  app.delete<IdParams>("/plugins/:id", async (req) => plugins.uninstall(req.params.id, actorOf(req)));

  // ── plugin MCP 기본값 ──
  app.get("/plugin-settings", async () => plugins.getSettings());

  app.put<{ Body: unknown }>("/plugin-settings", async (req) => plugins.updateSettings(req.body, actorOf(req)));
}
