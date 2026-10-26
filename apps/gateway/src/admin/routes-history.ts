import type { FastifyInstance } from "fastify";
import type { SessionRecord } from "../sessions/store.js";
import { readTranscript } from "../sessions/transcript.js";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

const LIST_LIMIT = 200;
const MAX_RETENTION_DAYS = 3650;

/** 서버에 저장된 대화 기록 보기(읽기 전용)와 보관 기간. 보관 기간이 지난 세션은 SessionHub가 지운다. */
export function registerHistoryRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { sessions } = ctx;
  const summary = (r: SessionRecord) => ({ id: r.id, user: r.principal, model: r.model, turn: r.turn, createdAt: r.createdAt, lastActiveAt: r.lastActiveAt });

  app.get("/history/retention", async () => sessions.retention());

  app.put<{ Body: { days?: unknown } | null }>("/history/retention", async (req) => {
    const days = req.body?.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
      throw new PlatformError(400, "invalid_retention", `days must be an integer from 0 to ${MAX_RETENTION_DAYS}`);
    }
    const actor = actorOf(req);
    ctx.log.info({ actor, days }, "session retention updated");
    return sessions.setRetention(days, actor);
  });

  app.get<{ Querystring: { user?: string } }>("/history", async (req) => ({
    items: sessions.list(req.query.user || undefined, LIST_LIMIT).map(summary),
    limit: LIST_LIMIT,
  }));

  app.get<{ Params: { id: string } }>("/history/:id", async (req) => {
    const record = sessions.get(req.params.id);
    if (!record) throw new PlatformError(404, "session_not_found", `session ${req.params.id} not found`);
    return { ...summary(record), messages: readTranscript(record) };
  });
}
