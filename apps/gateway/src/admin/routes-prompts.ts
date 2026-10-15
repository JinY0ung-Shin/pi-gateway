import type { FastifyInstance } from "fastify";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";

const BODY_LIMIT = 4 * 1024 * 1024;

type NameParams = { Params: { name: string } };

export function registerPromptRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { prompts } = ctx;

  app.get("/prompts", async () => prompts.list());

  app.post<{ Body: unknown }>("/prompts", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const created = prompts.create(req.body, actorOf(req));
    return reply.code(201).send(created);
  });

  app.get<NameParams>("/prompts/:name", async (req) => prompts.get(req.params.name));

  app.patch<NameParams & { Body: { description?: unknown } }>("/prompts/:name", async (req) =>
    prompts.updateDescription(req.params.name, req.body?.description, actorOf(req)),
  );

  app.delete<NameParams>("/prompts/:name", async (req, reply) => {
    prompts.remove(req.params.name, actorOf(req));
    return reply.code(204).send();
  });

  app.post<NameParams & { Body: { content?: unknown; message?: unknown; base_version?: unknown; baseVersion?: unknown } }>(
    "/prompts/:name/versions",
    { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = req.body ?? {};
      const version = prompts.addVersion(
        req.params.name,
        { content: body.content, message: body.message, baseVersion: body.baseVersion ?? body.base_version },
        actorOf(req),
      );
      return reply.code(201).send(version);
    },
  );

  app.post<NameParams & { Body: { version?: unknown; note?: unknown; expected_revision?: unknown; expectedRevision?: unknown } }>(
    "/prompts/:name/deploy",
    async (req) => {
      const body = req.body ?? {};
      return prompts.deploy(
        req.params.name,
        { version: body.version, note: body.note, expectedRevision: body.expectedRevision ?? body.expected_revision },
        actorOf(req),
      );
    },
  );

  app.get("/prompt-live", async () => prompts.live());

  app.post<{ Body: { note?: unknown; expected_revision?: unknown; expectedRevision?: unknown } }>("/prompt-live/reset", async (req) => {
    const body = req.body ?? {};
    return prompts.reset({ note: body.note, expectedRevision: body.expectedRevision ?? body.expected_revision }, actorOf(req));
  });

  app.get<{ Querystring: { limit?: string } }>("/prompt-deployments", async (req) => ({
    deployments: prompts.deployments(Number(req.query.limit ?? 50) || 50),
  }));

  app.post<{ Body: unknown }>("/prompt-render", { bodyLimit: BODY_LIMIT }, async (req) => prompts.render(req.body));
}
