import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { registerFileRoutes } from "./api/files.js";
import { type ResponsesDeps, registerResponsesRoutes } from "./api/responses.js";
import { registerAdminRoutes } from "./admin/index.js";
import type { AdminDeps } from "./contracts.js";
import { ApiError, apiError } from "./errors.js";

interface ServerDeps {
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
    const e = error instanceof ApiError ? error : toApiError(error, req.log);
    return reply.code(e.status).headers(e.headers).send(e.body);
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  registerResponsesRoutes(app, deps.responses);
  registerFileRoutes(app, deps.responses);
  await registerAdminRoutes(app, deps.admin);
  return app;
}

function toApiError(error: FastifyError, log: FastifyBaseLogger): ApiError {
  switch (error.code) {
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return apiError(400, "Request body is not valid JSON");
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return apiError(413, "Request body is too large", { type: "request_too_large" });
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return apiError(415, "Content-Type must be application/json");
  }
  const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
  if (status < 500) return apiError(status, error.message);
  log.error({ err: error }, "unhandled error");
  return apiError(500, "Internal server error");
}
