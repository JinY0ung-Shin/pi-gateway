import type { FastifyInstance } from "fastify";
import type { SessionRecord } from "../sessions/store.js";
import { readTranscript } from "../sessions/transcript.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";
import { sessionTraces, traceStats } from "./traces.js";

const LIST_LIMIT = 200;
const MAX_RETENTION_DAYS = 3650;

/** 서버에 저장된 대화 기록 보기(읽기 전용)와 보관 기간. 보관 기간이 지난 세션은 SessionHub가 지운다. */
export function registerHistoryRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { sessions } = ctx;
  const summary = (r: SessionRecord) => ({ id: r.id, user: r.principal, model: r.model, turn: r.turn, createdAt: r.createdAt, lastActiveAt: r.lastActiveAt });
  const session = (id: string) => {
    const record = sessions.get(id);
    if (!record) throw new PlatformError(404, "session_not_found", `session ${id} not found`);
    return record;
  };
  const jaegerHost = () => {
    const host = ctx.config.jaegerHost;
    if (!host) throw new PlatformError(404, "tracing_disabled", "JAEGER_HOST is not set");
    return host;
  };

  app.get("/history/retention", async () => sessions.retention());

  app.put<{ Body: { days?: unknown } | null }>("/history/retention", async (req) => {
    const days = req.body?.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
      throw new PlatformError(400, "invalid_retention", `days must be an integer from 0 to ${MAX_RETENTION_DAYS}`);
    }
    ctx.log.info({ days }, "session retention updated");
    return sessions.setRetention(days);
  });

  app.get<{ Querystring: { user?: string } }>("/history", async (req) => ({
    items: sessions.list(req.query.user || undefined, LIST_LIMIT).map(summary),
    limit: LIST_LIMIT,
  }));

  app.get<{ Params: { id: string } }>("/history/:id", async (req) => {
    const record = session(req.params.id);
    return { ...summary(record), messages: readTranscript(record) };
  });

  /** 최근 턴들의 trace로 낸 시간 통계 (관리 화면의 "실행 시간") */
  app.get("/traces/stats", async () => traceStats(jaegerHost()));

  /** 세션의 턴별 trace (최근 턴부터). Jaeger가 지운 뒤(7일)에는 비어 있다. */
  app.get<{ Params: { id: string } }>("/history/:id/traces", async (req) => {
    const record = session(req.params.id);
    return { traces: await sessionTraces(jaegerHost(), record.id, new Date(Date.parse(record.createdAt) - 60_000)) };
  });
}
