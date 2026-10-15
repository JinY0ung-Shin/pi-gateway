import { fileURLToPath } from "node:url";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import type { RegisterAdminRoutes } from "../contracts.js";
import { type AdminVia, CSRF_HEADER, isMutating } from "./auth.js";
import { type AdminContext, createAdminContext } from "./context.js";
import { isPlatformError, PlatformError } from "./errors.js";
import { registerMcpRoutes } from "./routes-mcp.js";
import { registerPluginRoutes } from "./routes-plugins.js";
import { registerPromptRoutes } from "./routes-prompts.js";
import { registerStatusRoutes } from "./routes-status.js";
import { registerAdminUi } from "./ui.js";

export { PlatformError } from "./errors.js";

/** 빌드된 관리 화면 위치. `ADMIN_UI_DIR`로 바꿀 수 있다 (src·dist 모두 apps/gateway/public/admin을 가리킨다). */
export function adminUiDir(): string {
  // 빈 값은 설정하지 않은 것으로 본다 ("" 를 경로로 쓰지 않는다).
  return process.env.ADMIN_UI_DIR || fileURLToPath(new URL("../../public/admin", import.meta.url));
}

/**
 * `/admin`(웹 UI)과 `/admin/api/*`(관리 API)를 등록한다.
 * 모든 hook·오류 처리는 이 scope 안에만 적용되어 gateway의 다른 라우트에 영향을 주지 않는다.
 */
export const registerAdminRoutes: RegisterAdminRoutes = async (app, deps) => {
  const ctx = createAdminContext(deps);
  const uiDir = adminUiDir();
  await app.register(async (admin) => {
    admin.addHook("onSend", async (_req, reply, payload) => {
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "no-referrer");
      return payload;
    });
    await admin.register(async (api) => registerApi(api, ctx), { prefix: "/admin/api" });
    await admin.register(async (ui) => registerAdminUi(ui, uiDir), { prefix: "/admin" });
  });
};

async function registerApi(api: FastifyInstance, ctx: AdminContext): Promise<void> {
  const vias = new WeakMap<FastifyRequest, { via: AdminVia; expiresAt?: string }>();

  api.setErrorHandler((error: FastifyError | PlatformError, req, reply) => {
    if (isPlatformError(error)) {
      const retryAfter = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (error.status === 429 && typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
      });
    }
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status < 500) {
      return reply.code(status).send({ error: { code: error.code ?? "invalid_request", message: error.message } });
    }
    // 요청 본문은 로그에 남기지 않는다 (비밀값이 들어 있을 수 있다).
    req.log.error({ err: { message: error.message, stack: error.stack } }, "admin API error");
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });

  api.setNotFoundHandler(async (req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: `no admin API route ${req.method} ${req.url.split("?")[0]}` } }),
  );

  api.addHook("onRequest", async (req) => {
    ctx.auth.requireEnabled();
    if (req.routeOptions.url === "/admin/api/login") return;
    const who = ctx.auth.authenticate(req);
    if (!who) throw new PlatformError(401, "unauthorized", "admin login required");
    vias.set(req, who);
    if (who.via === "cookie" && isMutating(req.method) && req.headers[CSRF_HEADER] !== "1") {
      throw new PlatformError(403, "csrf", "missing X-Admin-Request: 1 header");
    }
  });

  api.addHook("onSend", async (_req, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  api.post<{ Body: { apiKey?: unknown } }>("/login", async (req, reply) => {
    if (req.headers[CSRF_HEADER] !== "1") throw new PlatformError(403, "csrf", "missing X-Admin-Request: 1 header");
    const { expiresAt } = ctx.auth.login(req, reply, req.body?.apiKey);
    return { ok: true, expiresAt };
  });

  api.post("/logout", async (req, reply) => {
    ctx.auth.logout(req, reply);
    return { ok: true };
  });

  api.get("/session", async (req) => ({ authenticated: true, ...(vias.get(req) ?? {}) }));

  registerPromptRoutes(api, ctx);
  registerMcpRoutes(api, ctx);
  registerPluginRoutes(api, ctx);
  registerStatusRoutes(api, ctx);
}
