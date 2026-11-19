import type { FastifyInstance } from "fastify";
import { openDatabase } from "../db.js";
import { CRITERIA_CHARS, labelText, NAME_CHARS } from "../mining/labels.js";
import { type Label, MiningStore } from "../mining/store.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

const RUN_LIMIT = 30;
const REVISION_LIMIT = 100;
const EPISODE_LIMIT = 500;
const DAY_MS = 86_400_000;

/**
 * 프로세스 마이닝 관리 (docs/process-mining-design.md): 실행 이력과 "지금 실행", 매일 자동 실행 시각,
 * 프로세스(라벨) 목록과 그 작업(에피소드), 라벨 변경 이력, 사람이 하는 라벨 수정.
 * 실행은 mining 서비스가 한다. gateway는 mining.db에 요청과 설정, 라벨 수정만 쓴다.
 */
export function registerMiningRoutes(app: FastifyInstance, ctx: AdminContext): void {
  let opened: MiningStore | undefined;
  const mining = () => {
    try {
      return (opened ??= new MiningStore(openDatabase(ctx.miningDbFile)));
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, "mining.db could not be opened");
      throw new PlatformError(503, "mining_unavailable", "mining.db could not be opened (is the mining-data volume mounted?)");
    }
  };
  /** 세션 id → 사용자 (요청 하나 동안 기억한다). 세션이 지워졌으면 null */
  const userLookup = () => {
    const known = new Map<string, string | null>();
    return (sessionId: string) => {
      if (!known.has(sessionId)) known.set(sessionId, ctx.sessions.get(sessionId)?.principal ?? null);
      return known.get(sessionId)!;
    };
  };

  app.get("/mining", async () => {
    const store = mining();
    const now = Date.now();
    const weekAgo = new Date(now - 7 * DAY_MS).toISOString();
    const recent = store.recent(new Date(now - 30 * DAY_MS).toISOString());
    const userOf = userLookup();
    const stats = new Map<number, { recent7: number; recent30: number; users: Set<string> }>();
    for (const e of recent) {
      if (e.labelId === null) continue;
      const s = stats.get(e.labelId) ?? { recent7: 0, recent30: 0, users: new Set() };
      stats.set(e.labelId, s);
      s.recent30++;
      if (e.endedAt >= weekAgo) s.recent7++;
      const user = userOf(e.sessionId);
      if (user) s.users.add(user);
    }
    return {
      runs: store.runs(RUN_LIMIT),
      dailyAt: store.dailyAt(),
      labels: store.labels().map((l) => {
        const s = stats.get(l.id);
        return { id: l.id, name: l.name, criteria: l.criteria, createdAt: l.createdAt, editedAt: l.editedAt, flow: l.flow, total: l.count, recent7: s?.recent7 ?? 0, recent30: s?.recent30 ?? 0, users: s?.users.size ?? 0 };
      }),
      /** 라벨에 일어난 변경 (자동 실행과 사람), 최근 것부터 */
      revisions: store.revisions(REVISION_LIMIT),
      /** 최근 30일에 끝난 에피소드 수와, 그중 라벨이 없는 것 */
      recent30: recent.length,
      unlabeled30: recent.filter((e) => e.labelId === null).length,
    };
  });

  app.post("/mining/run", async () => {
    const id = mining().requestRun("manual", new Date().toISOString());
    if (id === undefined) throw new PlatformError(409, "mining_busy", "a run is already requested or in progress");
    ctx.log.info({ run: id }, "mining run requested");
    return { id };
  });

  app.put<{ Body: { dailyAt?: unknown } | null }>("/mining/schedule", async (req) => {
    const dailyAt = req.body?.dailyAt;
    if (dailyAt !== null && !(typeof dailyAt === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyAt))) {
      throw new PlatformError(400, "invalid_schedule", "dailyAt must be HH:MM (UTC) or null");
    }
    mining().setDailyAt(dailyAt);
    ctx.log.info({ dailyAt }, "mining schedule updated");
    return { dailyAt };
  });

  /** 최근에 끝난 것부터. label: 라벨 id, 또는 "none"(라벨 없음). user: 그 사용자의 것만 */
  app.get<{ Querystring: { label?: string; user?: string } }>("/mining/episodes", async (req) => {
    const { label, user } = req.query;
    const userOf = userLookup();
    const items = mining()
      .browse(label ? (label === "none" ? null : Number(label)) : undefined)
      .map((e) => ({ ...e, user: userOf(e.sessionId) }))
      .filter((e) => !user || e.user === user);
    return { items: items.slice(0, EPISODE_LIMIT), total: items.length };
  });

  // ── 라벨 수정 ───────────────────────────────────────────────────────

  const labelOf = (store: MiningStore, id: unknown): Label => {
    const label = store.labels().find((l) => l.id === Number(id));
    if (!label) throw new PlatformError(404, "label_not_found", `label ${String(id)} not found`);
    return label;
  };
  /** 실행 중이 아닐 때만 고친다. change가 던지면 아무것도 바뀌지 않는다. */
  const edit = (what: string, change: (store: MiningStore) => Record<string, unknown>) => {
    const store = mining();
    let about: Record<string, unknown> = {};
    const done = store.edit(() => {
      about = change(store);
    });
    if (!done) throw new PlatformError(409, "mining_running", "labels cannot be changed while a run is in progress");
    ctx.log.info(about, what);
    return { ok: true };
  };

  app.put<{ Params: { id: string }; Body: { name?: unknown; criteria?: unknown } | null }>("/mining/labels/:id", async (req) => {
    const name = typeof req.body?.name === "string" ? labelText(req.body.name, NAME_CHARS) : undefined;
    const criteria = typeof req.body?.criteria === "string" ? labelText(req.body.criteria, CRITERIA_CHARS) : undefined;
    if (!name || !criteria) {
      throw new PlatformError(400, "invalid_label", `name (at most ${NAME_CHARS} characters) and criteria (at most ${CRITERIA_CHARS}) must be plain text without markup or links`);
    }
    return edit("mining label renamed", (store) => {
      const label = labelOf(store, req.params.id);
      const at = new Date().toISOString();
      store.renameLabel(label.id, name, criteria, at);
      store.revise({ at, runId: null, labelId: label.id, kind: "refined", name, before: `${label.name} — ${label.criteria}`, after: `${name} — ${criteria}` });
      return { label: label.id };
    });
  });

  app.post<{ Params: { id: string }; Body: { into?: unknown } | null }>("/mining/labels/:id/merge", async (req) =>
    edit("mining label merged", (store) => {
      const from = labelOf(store, req.params.id);
      const into = labelOf(store, req.body?.into);
      if (from.id === into.id) throw new PlatformError(400, "invalid_merge", "a label cannot be merged into itself");
      const at = new Date().toISOString();
      store.mergeLabels([[from.id, into.id]], at);
      store.revise({ at, runId: null, labelId: from.id, kind: "merged", name: from.name, after: into.name });
      return { label: from.id, into: into.id };
    }),
  );

  app.delete<{ Params: { id: string } }>("/mining/labels/:id", async (req) =>
    edit("mining label deleted", (store) => {
      const label = labelOf(store, req.params.id);
      store.deleteLabel(label.id);
      store.revise({ at: new Date().toISOString(), runId: null, labelId: label.id, kind: "deleted", name: label.name, before: `${label.name} — ${label.criteria}` });
      return { label: label.id };
    }),
  );
}
