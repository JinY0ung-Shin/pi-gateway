import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

/** agent가 request_admin으로 남긴 요청. 처리하면 지운다. */
export function registerRequestRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get("/requests", async () => ({ items: ctx.adminRequests.list() }));

  app.delete<{ Params: { id: string } }>("/requests/:id", async (req) => {
    if (!ctx.adminRequests.remove(Number(req.params.id))) throw new PlatformError(404, "request_not_found", `request ${req.params.id} not found`);
    ctx.log.info({ request: req.params.id }, "admin request deleted");
    return { ok: true };
  });
}
