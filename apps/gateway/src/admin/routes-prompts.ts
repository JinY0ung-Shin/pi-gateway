import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";
import { pageOf } from "./errors.js";

const BODY_LIMIT = 4 * 1024 * 1024;
const DEPLOYMENT_PAGE = 10;

type NameParams = { Params: { name: string } };

export function registerPromptRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { prompts } = ctx;

  app.get("/prompts", async () => prompts.list());

  app.post<{ Body: unknown }>("/prompts", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const created = prompts.create(req.body);
    return reply.code(201).send(created);
  });

  app.get<NameParams>("/prompts/:name", async (req) => prompts.get(req.params.name));

  app.post<NameParams & { Body: unknown }>("/prompts/:name/versions", { bodyLimit: BODY_LIMIT }, async (req, reply) =>
    reply.code(201).send(prompts.addVersion(req.params.name, req.body)),
  );

  app.post<NameParams & { Body: unknown }>("/prompts/:name/deploy", async (req) => prompts.deploy(req.params.name, req.body));

  app.post<{ Body: unknown }>("/prompt-live/reset", async (req) => prompts.reset(req.body));

  /** 배포 이력, 최근 것부터 한 페이지 */
  app.get<{ Querystring: { page?: string } }>("/prompt-deployments", async (req) => ({
    items: prompts.deployments(DEPLOYMENT_PAGE, (pageOf(req.query.page) - 1) * DEPLOYMENT_PAGE),
    total: prompts.deploymentCount(),
    pageSize: DEPLOYMENT_PAGE,
  }));

  app.post<{ Body: unknown }>("/prompt-render", { bodyLimit: BODY_LIMIT }, async (req) => prompts.render(req.body));
}
