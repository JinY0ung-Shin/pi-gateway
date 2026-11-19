import { type Db, migrate } from "../db.js";

/**
 * mining의 상태 (gateway DB와 다른 파일). 세션 원문은 두지 않고, 요약한 에피소드와 라벨, 어디까지 읽었는지만 둔다.
 * 사용자는 저장하지 않는다. 필요할 때 gateway의 sessions에서 세션 id로 찾는다.
 *
 * 에피소드의 상태는 두 컬럼으로 읽는다:
 * - 배정 전: label_id도 assigned_at도 없다 (아직 라벨을 붙여 보지 않았다)
 * - 미분류: assigned_at만 있다 (붙여 봤지만 맞는 라벨이 없었다)
 * - 배정: label_id가 있다
 */

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
];

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

  episodes(ids: readonly number[]): Episode[] {
    return ids.flatMap((id) => this.#episodes("WHERE id = ?", id));
  }

  /** since 뒤에 끝난 에피소드 전부 (보고서용) */
  recent(since: string): Episode[] {
    return this.#episodes("WHERE ended_at >= ? ORDER BY ended_at DESC", since);
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
        this.db.prepare("UPDATE labels SET merged_into = ?, merged_at = ? WHERE id = ?").run(into, at, from);
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
}
