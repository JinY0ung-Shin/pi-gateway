import { type Db, migrate } from "../db.js";

/**
 * mining의 상태 (gateway DB와 다른 파일). 세션 원문은 두지 않고, 요약한 에피소드와 라벨, 어디까지 읽었는지, 실행 이력만 둔다.
 * 사용자는 저장하지 않는다. 필요할 때 gateway의 sessions에서 세션 id로 찾는다.
 *
 * 두 프로세스가 연다: mining 서비스(실행)와 gateway(관리 화면: 실행 요청, 자동 실행 시각, 라벨 수정).
 *
 * 에피소드의 상태는 두 컬럼으로 읽는다:
 * - 배정 전: label_id도 assigned_at도 없다 (아직 라벨을 붙여 보지 않았다)
 * - 미분류: assigned_at만 있다 (붙여 봤지만 맞는 라벨이 없었다)
 * - 배정: label_id가 있다
 */

/** compose의 mining-data 볼륨. mining 서비스와 gateway가 같은 파일을 연다. */
export const MINING_DB = "/mining/mining.db";

const MIGRATIONS = [
  `CREATE TABLE session_cursor (
     session_id TEXT PRIMARY KEY,
     entry_id TEXT NOT NULL
   );
   CREATE TABLE episodes (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT NOT NULL,
     goal TEXT NOT NULL,
     steps TEXT NOT NULL
   );
   CREATE INDEX episodes_session ON episodes(session_id)`,
  `ALTER TABLE episodes ADD COLUMN label_id INTEGER;
   ALTER TABLE episodes ADD COLUMN assigned_at TEXT;
   CREATE INDEX episodes_label ON episodes(label_id);
   CREATE TABLE labels (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     criteria TEXT NOT NULL,
     created_at TEXT NOT NULL,
     merged_into INTEGER,
     merged_at TEXT,
     flow TEXT,
     flow_count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     trigger TEXT NOT NULL,
     requested_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     status TEXT NOT NULL,
     processed INTEGER,
     failed INTEGER,
     remaining INTEGER,
     episodes INTEGER,
     model TEXT,
     error TEXT
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** 실행 하나. requested(요청됨) → running(실행 중) → 나머지는 끝난 상태다. */
export interface Run {
  id: number;
  trigger: "manual" | "schedule";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "requested" | "running" | "completed" | "time_limit" | "aborted" | "failed";
  /** 끝까지 읽은 세션, 읽다 실패한 세션, 남은 세션, 만들거나 고친 에피소드 수. 끝나기 전이나 시작하지 못했으면 null */
  processed: number | null;
  failed: number | null;
  remaining: number | null;
  episodes: number | null;
  model: string | null;
  /** 시작하지 못했거나 도중에 죽은 이유 */
  error: string | null;
}

export interface RunOutcome {
  status: Exclude<Run["status"], "requested" | "running">;
  processed?: number;
  failed?: number;
  remaining?: number;
  episodes?: number;
  model?: string;
  error?: string;
}

/** 매일 time("HH:MM", UTC)에 오는 시각이 after 뒤, now 이하에 있었는가 */
export function cameDue(time: string, after: number, now: number): boolean {
  const [hour, minute] = time.split(":").map(Number);
  const today = new Date(now).setUTCHours(hour!, minute!, 0, 0);
  const last = today <= now ? today : today - 86_400_000;
  return last > after;
}

const RUN =
  "SELECT id, trigger, requested_at AS requestedAt, started_at AS startedAt, finished_at AS finishedAt, status, processed, failed, remaining, episodes, model, error FROM runs";
const DAILY_AT = "daily_at";

export interface Episode {
  id: number;
  sessionId: string;
  endedAt: string;
  goal: string;
  steps: string[];
  /** 배정된 라벨. 없으면 배정 전이거나 미분류다. */
  labelId: number | null;
}

export interface NewEpisode {
  /** 그 세션의 마지막 에피소드를 이어 간 것 (새 행을 만들지 않고 덮어쓴다) */
  continues: boolean;
  startedAt: string;
  endedAt: string;
  goal: string;
  steps: string[];
}

/** 합쳐지지 않은 라벨 */
export interface Label {
  id: number;
  name: string;
  /** 어떤 작업이 여기에 드는지 */
  criteria: string;
  createdAt: string;
  /** 대표 흐름. 아직 만들지 않았으면 null */
  flow: string[] | null;
  /** 대표 흐름을 만들 때의 에피소드 수 */
  flowCount: number;
  /** 지금 배정된 에피소드 수 */
  count: number;
}

interface EpisodeRow {
  id: number;
  session_id: string;
  ended_at: string;
  goal: string;
  steps: string;
  label_id: number | null;
}

const EPISODE = "SELECT id, session_id, ended_at, goal, steps, label_id FROM episodes";

const toEpisode = (row: EpisodeRow): Episode => ({
  id: row.id,
  sessionId: row.session_id,
  endedAt: row.ended_at,
  goal: row.goal,
  steps: JSON.parse(row.steps) as string[],
  labelId: row.label_id,
});

export class MiningStore {
  constructor(private readonly db: Db) {
    migrate(db, "mining", MIGRATIONS);
  }

  #episodes(where: string, ...params: unknown[]): Episode[] {
    return (this.db.prepare(`${EPISODE} ${where}`).all(...params) as EpisodeRow[]).map(toEpisode);
  }

  // ── 세션과 에피소드 ─────────────────────────────────────────────────

  /** 그 세션에서 분석을 마친 마지막 엔트리 id */
  cursor(sessionId: string): string | undefined {
    return (this.db.prepare("SELECT entry_id FROM session_cursor WHERE session_id = ?").get(sessionId) as { entry_id: string } | undefined)?.entry_id;
  }

  lastEpisode(sessionId: string): Episode | undefined {
    return this.#episodes("WHERE session_id = ? ORDER BY id DESC LIMIT 1", sessionId)[0];
  }

  /** 에피소드를 저장하고 커서를 옮긴다. 저장하거나 고친 에피소드 id를 돌려준다. 이어 간 에피소드는 내용이 바뀌었으므로 배정 전으로 되돌린다. */
  save(sessionId: string, episodes: NewEpisode[], cursor: string): number[] {
    const ids: number[] = [];
    this.db.transaction(() => {
      for (const e of episodes) {
        const last = e.continues ? this.lastEpisode(sessionId) : undefined;
        if (last) {
          this.db
            .prepare("UPDATE episodes SET ended_at = ?, goal = ?, steps = ?, label_id = NULL, assigned_at = NULL WHERE id = ?")
            .run(e.endedAt, e.goal, JSON.stringify(e.steps), last.id);
          ids.push(last.id);
        } else {
          const { lastInsertRowid } = this.db
            .prepare("INSERT INTO episodes (session_id, started_at, ended_at, goal, steps) VALUES (?, ?, ?, ?, ?)")
            .run(sessionId, e.startedAt, e.endedAt, e.goal, JSON.stringify(e.steps));
          ids.push(Number(lastInsertRowid));
        }
      }
      this.db
        .prepare("INSERT INTO session_cursor (session_id, entry_id) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET entry_id = excluded.entry_id")
        .run(sessionId, cursor);
    })();
    return ids;
  }

  /** 세션의 에피소드와 커서를 지운다 (분기해서 다시 읽거나, 세션이 지워졌을 때). */
  reset(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM episodes WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM session_cursor WHERE session_id = ?").run(sessionId);
    })();
  }

  /** gateway에서 지워진 세션의 것을 지운다 (대화 기록 보관 기간을 따라간다). 라벨은 남는다. */
  prune(alive: { has(sessionId: string): boolean }): void {
    const known = this.db.prepare("SELECT session_id FROM session_cursor UNION SELECT session_id FROM episodes").all() as { session_id: string }[];
    for (const { session_id } of known) if (!alive.has(session_id)) this.reset(session_id);
  }

  /** since 뒤에 끝난 에피소드 전부 (건수용) */
  recent(since: string): Episode[] {
    return this.#episodes("WHERE ended_at >= ? ORDER BY ended_at DESC", since);
  }

  /** 최근에 끝난 것부터. label을 주면 그 라벨의 것만, null이면 라벨이 없는 것만 */
  browse(label?: number | null): Episode[] {
    if (label === undefined) return this.#episodes("ORDER BY ended_at DESC");
    return label === null ? this.#episodes("WHERE label_id IS NULL ORDER BY ended_at DESC") : this.#episodes("WHERE label_id = ? ORDER BY ended_at DESC", label);
  }

  // ── 배정 ────────────────────────────────────────────────────────────

  /** 배정 전인 에피소드 */
  pending(): Episode[] {
    return this.#episodes("WHERE label_id IS NULL AND assigned_at IS NULL ORDER BY id");
  }

  /** 라벨을 붙인다. labelId가 null이면 미분류로 둔다. */
  assign(episodeIds: readonly number[], labelId: number | null, at: string): void {
    const set = this.db.prepare("UPDATE episodes SET label_id = ?, assigned_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of episodeIds) set.run(labelId, at, id);
    })();
  }

  /** since 뒤에 끝난 미분류 에피소드 수 */
  unlabeledCount(since: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE label_id IS NULL AND assigned_at IS NOT NULL AND ended_at >= ?").get(since) as { n: number }
    ).n;
  }

  /** since 뒤에 끝난 미분류 에피소드에서 무작위로 limit건 */
  unlabeledSample(since: string, limit: number): Episode[] {
    return this.#episodes("WHERE label_id IS NULL AND assigned_at IS NOT NULL AND ended_at >= ? ORDER BY RANDOM() LIMIT ?", since, limit);
  }

  /** since 뒤에 끝난 미분류 에피소드를 배정 전으로 되돌린다 (새 라벨이 생겼으니 다시 붙여 본다). */
  reopenUnlabeled(since: string): void {
    this.db.prepare("UPDATE episodes SET assigned_at = NULL WHERE label_id IS NULL AND assigned_at IS NOT NULL AND ended_at >= ?").run(since);
  }

  // ── 라벨 ────────────────────────────────────────────────────────────

  /** 합쳐지지 않은 라벨, 만든 순서대로 */
  labels(): Label[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, criteria, created_at, flow, flow_count, (SELECT COUNT(*) FROM episodes e WHERE e.label_id = labels.id) AS count
         FROM labels WHERE merged_into IS NULL ORDER BY id`,
      )
      .all() as { id: number; name: string; criteria: string; created_at: string; flow: string | null; flow_count: number; count: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      criteria: r.criteria,
      createdAt: r.created_at,
      flow: r.flow ? (JSON.parse(r.flow) as string[]) : null,
      flowCount: r.flow_count,
      count: r.count,
    }));
  }

  /** 라벨을 만들고 그 에피소드를 배정한다. */
  createLabel(name: string, criteria: string, episodeIds: readonly number[], at: string): number {
    let id = 0;
    this.db.transaction(() => {
      id = Number(this.db.prepare("INSERT INTO labels (name, criteria, created_at) VALUES (?, ?, ?)").run(name, criteria, at).lastInsertRowid);
      this.assign(episodeIds, id, at);
    })();
    return id;
  }

  /** [합쳐질 라벨, 남을 라벨] 쌍을 한꺼번에 적용한다. 에피소드는 남을 라벨로 옮긴다. */
  mergeLabels(pairs: readonly (readonly [from: number, into: number])[], at: string): void {
    this.db.transaction(() => {
      for (const [from, into] of pairs) {
        this.db.prepare("UPDATE episodes SET label_id = ? WHERE label_id = ?").run(into, from);
        this.db.prepare("UPDATE labels SET merged_into = ?, merged_at = ? WHERE id = ? OR merged_into = ?").run(into, at, from, from);
      }
    })();
  }

  /** 그 라벨의 에피소드, 최근 것부터 limit건 */
  latestOf(labelId: number, limit: number): Episode[] {
    return this.#episodes("WHERE label_id = ? ORDER BY ended_at DESC LIMIT ?", labelId, limit);
  }

  /** count: 이 흐름을 만들 때의 에피소드 수 */
  setFlow(labelId: number, steps: readonly string[], count: number): void {
    this.db.prepare("UPDATE labels SET flow = ?, flow_count = ? WHERE id = ?").run(JSON.stringify(steps), count, labelId);
  }

  // ── 사람이 고치는 라벨 (관리 화면) ─────────────────────────────────

  /**
   * 라벨을 고치는 일을 한다. 실행 중에는 하지 않고 false를 돌려준다: 실행은 라벨 목록을 읽어 둔 채로 LLM을 부르므로,
   * 그 사이에 합치거나 지우면 없는 라벨에 배정된다. 실행 시작도 쓰기라서 이 검사와 순서가 섞이지 않는다.
   */
  edit(change: () => void): boolean {
    return this.db
      .transaction(() => {
        if (this.db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get()) return false;
        change();
        return true;
      })
      .immediate();
  }

  renameLabel(id: number, name: string, criteria: string): void {
    this.db.prepare("UPDATE labels SET name = ?, criteria = ? WHERE id = ?").run(name, criteria, id);
  }

  /** 라벨을 없앤다. 그 에피소드는 배정 전으로 돌아가 다음 실행이 다시 붙여 본다. */
  deleteLabel(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE episodes SET label_id = NULL, assigned_at = NULL WHERE label_id = ?").run(id);
      this.db.prepare("DELETE FROM labels WHERE id = ? OR merged_into = ?").run(id, id);
    })();
  }

  // ── 실행 ────────────────────────────────────────────────────────────

  /** 최근 실행부터 limit건 */
  runs(limit: number): Run[] {
    return this.db.prepare(`${RUN} ORDER BY id DESC LIMIT ?`).all(limit) as Run[];
  }

  /** 실행을 요청한다. 이미 요청됐거나 실행 중이면 만들지 않고 undefined를 돌려준다. */
  requestRun(trigger: Run["trigger"], at: string): number | undefined {
    return this.db
      .transaction(() => {
        if (this.db.prepare("SELECT 1 FROM runs WHERE status IN ('requested', 'running')").get()) return undefined;
        return Number(this.db.prepare("INSERT INTO runs (trigger, requested_at, status) VALUES (?, ?, 'requested')").run(trigger, at).lastInsertRowid);
      })
      .immediate();
  }

  /** 요청된 실행이 있으면 실행 중으로 바꾸고 그 id를 돌려준다. */
  startRun(at: string): number | undefined {
    return this.db
      .transaction(() => {
        const next = this.db.prepare("SELECT id FROM runs WHERE status = 'requested' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
        if (next) this.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(at, next.id);
        return next?.id;
      })
      .immediate();
  }

  /** 실행 중인 실행을 끝낸다. id를 주지 않으면 실행 중인 것 전부 (서비스가 죽었다 살아났을 때). 이미 끝난 것은 건드리지 않는다. */
  finishRun(id: number | undefined, outcome: RunOutcome, at: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, processed = ?, failed = ?, remaining = ?, episodes = ?, model = ?, error = ?
         WHERE status = 'running' AND (? IS NULL OR id = ?)`,
      )
      .run(outcome.status, at, outcome.processed ?? null, outcome.failed ?? null, outcome.remaining ?? null, outcome.episodes ?? null, outcome.model ?? null, outcome.error ?? null, id ?? null, id ?? null);
  }

  /** 매일 자동으로 실행하는 시각 ("HH:MM", UTC). 없으면 자동으로 실행하지 않는다. */
  dailyAt(): string | null {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(DAILY_AT) as { value: string } | undefined)?.value ?? null;
  }

  setDailyAt(time: string | null): void {
    if (time === null) this.db.prepare("DELETE FROM settings WHERE key = ?").run(DAILY_AT);
    else this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(DAILY_AT, time);
  }
}
