import { type Db, migrate } from "../db.js";

/**
 * mining의 상태 (gateway DB와 다른 파일). 세션 원문은 두지 않고, 요약한 에피소드와 어디까지 읽었는지만 둔다.
 * 사용자는 저장하지 않는다. 필요할 때 gateway의 sessions에서 세션 id로 찾는다.
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
];

export interface Episode {
  id: number;
  sessionId: string;
  goal: string;
  steps: string[];
}

export interface NewEpisode {
  /** 그 세션의 마지막 에피소드를 이어 간 것 (새 행을 만들지 않고 덮어쓴다) */
  continues: boolean;
  startedAt: string;
  endedAt: string;
  goal: string;
  steps: string[];
}

interface Row {
  id: number;
  session_id: string;
  goal: string;
  steps: string;
}

const fromRow = (row: Row): Episode => ({ id: row.id, sessionId: row.session_id, goal: row.goal, steps: JSON.parse(row.steps) as string[] });

export class MiningStore {
  constructor(private readonly db: Db) {
    migrate(db, "mining", MIGRATIONS);
  }

  /** 그 세션에서 분석을 마친 마지막 엔트리 id */
  cursor(sessionId: string): string | undefined {
    return (this.db.prepare("SELECT entry_id FROM session_cursor WHERE session_id = ?").get(sessionId) as { entry_id: string } | undefined)?.entry_id;
  }

  lastEpisode(sessionId: string): Episode | undefined {
    const row = this.db.prepare("SELECT id, session_id, goal, steps FROM episodes WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId) as Row | undefined;
    return row && fromRow(row);
  }

  /** 에피소드를 저장하고 커서를 옮긴다. 저장하거나 고친 에피소드 id를 돌려준다. */
  save(sessionId: string, episodes: NewEpisode[], cursor: string): number[] {
    const ids: number[] = [];
    this.db.transaction(() => {
      for (const e of episodes) {
        const last = e.continues ? this.lastEpisode(sessionId) : undefined;
        if (last) {
          this.db.prepare("UPDATE episodes SET ended_at = ?, goal = ?, steps = ? WHERE id = ?").run(e.endedAt, e.goal, JSON.stringify(e.steps), last.id);
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

  /** gateway에서 지워진 세션의 것을 지운다 (대화 기록 보관 기간을 따라간다). */
  prune(alive: { has(sessionId: string): boolean }): void {
    const known = this.db.prepare("SELECT session_id FROM session_cursor UNION SELECT session_id FROM episodes").all() as { session_id: string }[];
    for (const { session_id } of known) if (!alive.has(session_id)) this.reset(session_id);
  }

  episodes(ids: readonly number[]): Episode[] {
    const get = this.db.prepare("SELECT id, session_id, goal, steps FROM episodes WHERE id = ?");
    return ids.flatMap((id) => {
      const row = get.get(id) as Row | undefined;
      return row ? [fromRow(row)] : [];
    });
  }
}
