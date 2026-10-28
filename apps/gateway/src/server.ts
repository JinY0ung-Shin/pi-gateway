import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { registerFileRoutes } from "./api/files.js";
import { type ResponsesDeps, registerResponsesRoutes } from "./api/responses.js";
import { registerAdminRoutes } from "./admin/index.js";
import type { AdminDeps } from "./contracts.js";
import { ApiError, apiError, validationError } from "./errors.js";

export interface ServerDeps {
  logger: Logger;
  responses: ResponsesDeps;
  admin: AdminDeps;
  /** Fastify trustProxy (TRUST_PROXY). 프록시 뒤에서 req.ip·req.protocol이 클라이언트 기준이 된다. */
  trustProxy: false | string[];
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: deps.trustProxy,
  });

  app.setErrorHandler((error: FastifyError | ApiError, req, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).headers(error.headers).send(error.body);
    }
    if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      const e = apiError(400, "Request body is not valid JSON");
      return reply.code(e.status).send(e.body);
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: { message: "Request body is too large", type: "request_too_large", code: 413 } });
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      const e = apiError(415, "Content-Type must be application/json");
      return reply.code(e.status).send(e.body);
    }
    if (error.validation) {
      const e = validationError(error.validation);
      return reply.code(e.status).send(e.body);
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: error }, "unhandled error");
      return reply.code(500).send({ error: { message: "Internal server error", type: "api_error", code: "500" } });
    }
    return reply.code(status).send({ error: { message: error.message, type: "api_error", code: String(status) } });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  registerResponsesRoutes(app, deps.responses);
  registerFileRoutes(app, deps.responses);
  await registerAdminRoutes(app, deps.admin);
  return app;
}
