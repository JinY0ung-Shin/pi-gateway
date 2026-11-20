import type { FastifyInstance } from "fastify";
import { openDatabase } from "../db.js";
import { CRITERIA_CHARS, labelText, NAME_CHARS } from "../mining/labels.js";
import { IDLE_MS, type Label, MAX_CONCURRENCY, MiningStore, RECENT_MS, type Working } from "../mining/store.js";
import type { AdminContext } from "./context.js";
import { pageOf, PlatformError } from "./errors.js";

const RUN_PAGE = 10;
const REVISION_PAGE = 10;
const EPISODE_PAGE = 20;
const DAY_MS = 86_400_000;

/**
 * 프로세스 마이닝 관리 (docs/process-mining-design.md): 지금 실행의 진행 상황과 실행 이력, "지금 실행"과 중지, 매일 자동 실행 시각, 동시 호출 수, 모델,
 * 프로세스(라벨) 목록과 그 작업(에피소드), 라벨 변경 이력, 사람이 하는 라벨 수정.
 * 실행은 mining 서비스가 한다. gateway는 mining.db에 실행·중지 요청과 설정, 라벨 수정만 쓴다.
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

  /** 지금 LLM에 보내 둔 호출이 다루는 것을 화면에 보일 말로: 세션은 그 사용자, 에피소드는 목표, 라벨은 이름 */
  const shown = (store: MiningStore, working: Working[]) => {
    const userOf = userLookup();
    const labels = store.labels();
    return working.flatMap((w): ({ kind: "session"; sessionId: string; user: string | null } | { kind: "episode" | "label"; text: string })[] => {
      if (w.session) return [{ kind: "session", sessionId: w.session, user: userOf(w.session) }];
      if (w.episode !== undefined) return [{ kind: "episode", text: store.goalOf(w.episode) ?? `작업 ${w.episode}` }];
      if (w.label !== undefined) return [{ kind: "label", text: labels.find((l) => l.id === w.label)?.name ?? `프로세스 ${w.label}` }];
      return [];
    });
  };

  app.get("/mining", async () => {
    const store = mining();
    const now = Date.now();
    const active = store.activeRun();
    // 지금 실행하면 읽을 세션: 실행과 같은 기준 (최근 30일, 30분 넘게 쉼, 읽은 뒤로 새 내용이 있음)
    const cursors = store.cursors();
    const unread = ctx.sessions.leaves(new Date(now - RECENT_MS).toISOString(), new Date(now - IDLE_MS).toISOString()).filter((s) => cursors.get(s.id) !== s.leafId).length;
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
      /** 요청됐거나 실행 중인 실행 (진행 상황이 들어 있다)과, 가장 최근에 끝난 실행 */
      active: active ? { ...active, working: shown(store, active.working) } : null,
      last: store.lastRun() ?? null,
      /** 지금 실행하면 할 일: 읽을 세션 수와, 프로세스에 붙여 볼 작업 수 (읽으면서 더 생긴다) */
      next: { sessions: unread, episodes: store.pendingCount() },
      dailyAt: store.dailyAt(),
      concurrency: store.concurrency(),
      /** 실행이 쓰는 모델. null이면 gateway의 기본 모델 */
      model: store.model(),
      labels: store.labels().map((l) => {
        const s = stats.get(l.id);
        return { id: l.id, name: l.name, criteria: l.criteria, createdAt: l.createdAt, editedAt: l.editedAt, flow: l.flow, total: l.count, recent7: s?.recent7 ?? 0, recent30: s?.recent30 ?? 0, users: s?.users.size ?? 0 };
      }),
      /** 최근 30일에 끝난 에피소드 수와, 그중 라벨이 없는 것 */
      recent30: recent.length,
      unlabeled30: recent.filter((e) => e.labelId === null).length,
    };
  });

  /** 실행 이력, 최근 것부터 한 페이지 */
  app.get<{ Querystring: { page?: string } }>("/mining/runs", async (req) => {
    const store = mining();
    return { items: store.runs(RUN_PAGE, (pageOf(req.query.page) - 1) * RUN_PAGE), total: store.runCount(), pageSize: RUN_PAGE };
  });

  /** 라벨에 일어난 변경 (자동 실행과 사람), 최근 것부터 한 페이지. label: 그 라벨의 것만 */
  app.get<{ Querystring: { page?: string; label?: string } }>("/mining/revisions", async (req) => {
    const store = mining();
    const label = req.query.label ? Number(req.query.label) : undefined;
    return { items: store.revisions(REVISION_PAGE, (pageOf(req.query.page) - 1) * REVISION_PAGE, label), total: store.revisionCount(label), pageSize: REVISION_PAGE };
  });

  app.post("/mining/run", async () => {
    const id = mining().requestRun("manual", new Date().toISOString());
    if (id === undefined) throw new PlatformError(409, "mining_busy", "a run is already requested or in progress");
    ctx.log.info({ run: id }, "mining run requested");
    return { id };
  });

  app.post("/mining/run/stop", async () => {
    if (!mining().requestStop(new Date().toISOString())) throw new PlatformError(409, "mining_idle", "no run is requested or in progress");
    ctx.log.info("mining run stop requested");
    return { ok: true };
  });

  app.put<{ Body: { value?: unknown } | null }>("/mining/concurrency", async (req) => {
    const value = req.body?.value;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
      throw new PlatformError(400, "invalid_concurrency", `value must be an integer from 1 to ${MAX_CONCURRENCY}`);
    }
    mining().setConcurrency(value);
    ctx.log.info({ concurrency: value }, "mining concurrency updated");
    return { value };
  });

  /** model: 모델 id나 티어, 또는 null (gateway의 기본 모델을 따른다) */
  app.put<{ Body: { model?: unknown } | null }>("/mining/model", async (req) => {
    const model = req.body?.model;
    if (model !== null && (typeof model !== "string" || !ctx.llm.list().some((m) => m.id === model))) {
      throw new PlatformError(400, "invalid_model", "model must be one of the configured models or tiers, or null");
    }
    mining().setModel(model);
    ctx.log.info({ model }, "mining model updated");
    return { model };
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

  /**
   * 최근에 끝난 것부터 한 페이지. label: 라벨 id, 또는 "none"(라벨 없음). user: 그 사용자의 것만.
   * total과 counts(라벨별 수, 많은 순. labelId가 null이면 라벨 없음)는 조건에 맞는 것 전부를 센다.
   */
  app.get<{ Querystring: { label?: string; user?: string; page?: string } }>("/mining/episodes", async (req) => {
    const { label, user } = req.query;
    const userOf = userLookup();
    const items = mining()
      .browse(label ? (label === "none" ? null : Number(label)) : undefined)
      .map((e) => ({ ...e, user: userOf(e.sessionId) }))
      .filter((e) => !user || e.user === user);
    const counts = new Map<number | null, number>();
    for (const e of items) counts.set(e.labelId, (counts.get(e.labelId) ?? 0) + 1);
    const start = (pageOf(req.query.page) - 1) * EPISODE_PAGE;
    return {
      items: items.slice(start, start + EPISODE_PAGE),
      total: items.length,
      pageSize: EPISODE_PAGE,
      counts: [...counts].map(([labelId, count]) => ({ labelId, count })).sort((a, b) => b.count - a.count),
    };
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
