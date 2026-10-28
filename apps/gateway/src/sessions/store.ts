import type { OutputFormat } from "../api/request.js";
import { type Db, migrate } from "../db.js";

/** gateway가 기억하는 세션 메타. 대화 내용 자체는 pi JSONL에 있다. */

export interface PendingToolCall {
  call_id: string;
  name: string;
  arguments: unknown;
}

export interface SessionRecord {
  id: string;
  /** 사용자 id */
  principal: string;
  model: string;
  thinkingLevel: string;
  /** commit된 마지막 turn 번호 (0 = 아직 없음) */
  turn: number;
  /** pi JSONL 경로. 첫 메시지가 기록되기 전에는 null */
  sessionFile: string | null;
  /** 마지막 commit 시점의 pi leaf entry id (관리 화면 대화 기록이 여기까지 보여준다) */
  leafId: string | null;
  promptText: string;
  /** pi addendum: 첫 턴 instructions + `Current user:` */
  appendPrompt: string;
  /** 세션을 만들 때의 skill 이름 목록 (이후 설치된 skill은 새 세션부터) */
  skillNames: string[];
  /** 첫 요청의 text.format json_schema. 세션 동안 바뀌지 않는다. */
  outputFormat: OutputFormat | null;
  createdAt: string;
  lastActiveAt: string;
}

interface Row {
  id: string;
  principal: string;
  model: string;
  thinking_level: string;
  turn: number;
  session_file: string | null;
  leaf_id: string | null;
  prompt_text: string;
  append_prompt: string;
  skill_names: string;
  output_format: string | null;
  created_at: string;
  last_active_at: string;
}

const MIGRATIONS = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     user TEXT,
     model TEXT NOT NULL,
     thinking_level TEXT NOT NULL,
     turn INTEGER NOT NULL DEFAULT 0,
     session_file TEXT,
     leaf_id TEXT,
     prompt_text TEXT NOT NULL,
     prompt_ref TEXT NOT NULL,
     append_prompt TEXT NOT NULL,
     skill_names TEXT NOT NULL,
     pending_tool_call TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     last_active_at TEXT NOT NULL
   )`,
  `CREATE INDEX sessions_principal ON sessions(principal)`,
  `CREATE INDEX sessions_last_active ON sessions(last_active_at)`,
  `CREATE TABLE session_retention (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     days INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  // user는 principal과 늘 같았고, prompt_ref는 읽는 곳이 없었다.
  `ALTER TABLE sessions DROP COLUMN user;
   ALTER TABLE sessions DROP COLUMN prompt_ref`,
  // 관리 화면은 행위자를 보내지 않아 늘 "admin"이었다.
  `ALTER TABLE session_retention DROP COLUMN updated_by`,
  `ALTER TABLE sessions ADD COLUMN output_format TEXT`,
  // 예전 응답에서도 이어갈 수 있게 (메시지 수정·재생성) turn마다 끝난 지점을 남긴다.
  `CREATE TABLE session_turns (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     turn INTEGER NOT NULL,
     leaf_id TEXT,
     pending_tool_call TEXT,
     PRIMARY KEY (session_id, turn)
   );
   INSERT INTO session_turns (session_id, turn, leaf_id, pending_tool_call)
     SELECT id, turn, leaf_id, pending_tool_call FROM sessions WHERE turn > 0;
   ALTER TABLE sessions DROP COLUMN pending_tool_call`,
];

/** commit된 turn이 끝난 지점. 그 응답에서 이어갈 때 pi leaf를 여기로 옮긴다. */
export interface TurnPoint {
  leafId: string | null;
  /** 그 turn이 사용자 답을 기다리며 끝났으면 그 질문 */
  pendingToolCall: PendingToolCall | null;
}

/** 대화 기록 보관 기간. 마지막 활동 뒤 days일이 지나면 지운다 (0 = 지우지 않는다). */
export interface Retention {
  days: number;
  updatedAt: string | null;
}

function fromRow(row: Row): SessionRecord {
  return {
    id: row.id,
    principal: row.principal,
    model: row.model,
    thinkingLevel: row.thinking_level,
    turn: row.turn,
    sessionFile: row.session_file,
    leafId: row.leaf_id,
    promptText: row.prompt_text,
    appendPrompt: row.append_prompt,
    skillNames: JSON.parse(row.skill_names) as string[],
    outputFormat: row.output_format ? (JSON.parse(row.output_format) as OutputFormat) : null,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export class SessionStore {
  constructor(private readonly db: Db) {
    migrate(db, "gateway-sessions", MIGRATIONS);
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  insert(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, principal, model, thinking_level, turn, session_file, leaf_id, prompt_text,
           append_prompt, skill_names, output_format, created_at, updated_at, last_active_at)
         VALUES (@id, @principal, @model, @thinking_level, @turn, @session_file, @leaf_id, @prompt_text,
           @append_prompt, @skill_names, @output_format, @created_at, @created_at, @last_active_at)`,
      )
      .run({
        id: record.id,
        principal: record.principal,
        model: record.model,
        thinking_level: record.thinkingLevel,
        turn: record.turn,
        session_file: record.sessionFile,
        leaf_id: record.leafId,
        prompt_text: record.promptText,
        append_prompt: record.appendPrompt,
        skill_names: JSON.stringify(record.skillNames),
        output_format: record.outputFormat ? JSON.stringify(record.outputFormat) : null,
        created_at: record.createdAt,
        last_active_at: record.lastActiveAt,
      });
  }

  /** turn을 commit한다 (turn 번호, leaf, 대기 중인 질문, 세션 파일). */
  commit(
    id: string,
    patch: { turn: number; leafId: string | null; sessionFile: string | null; pendingToolCall: PendingToolCall | null },
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions SET turn = ?, leaf_id = ?, session_file = COALESCE(?, session_file), updated_at = ?, last_active_at = ?
           WHERE id = ?`,
        )
        .run(patch.turn, patch.leafId, patch.sessionFile, now, now, id);
      this.db
        .prepare("INSERT INTO session_turns (session_id, turn, leaf_id, pending_tool_call) VALUES (?, ?, ?, ?)")
        .run(id, patch.turn, patch.leafId, patch.pendingToolCall ? JSON.stringify(patch.pendingToolCall) : null);
    })();
  }

  turnPoint(id: string, turn: number): TurnPoint | undefined {
    const row = this.db.prepare("SELECT leaf_id, pending_tool_call FROM session_turns WHERE session_id = ? AND turn = ?").get(id, turn) as
      | { leaf_id: string | null; pending_tool_call: string | null }
      | undefined;
    if (!row) return undefined;
    return { leafId: row.leaf_id, pendingToolCall: row.pending_tool_call ? (JSON.parse(row.pending_tool_call) as PendingToolCall) : null };
  }

  setSessionFile(id: string, sessionFile: string): void {
    this.db.prepare("UPDATE sessions SET session_file = ? WHERE id = ? AND session_file IS NULL").run(sessionFile, id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** 최근 활동 순 (user를 주면 그 사용자의 세션만) */
  list(user: string | undefined, limit: number): SessionRecord[] {
    const rows = user
      ? this.db.prepare("SELECT * FROM sessions WHERE principal = ? ORDER BY last_active_at DESC LIMIT ?").all(user, limit)
      : this.db.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(fromRow);
  }

  /** 마지막 활동이 before보다 이른 세션 id */
  inactiveSince(before: string): string[] {
    return (this.db.prepare("SELECT id FROM sessions WHERE last_active_at < ?").all(before) as { id: string }[]).map((r) => r.id);
  }

  retention(): Retention {
    const row = this.db.prepare("SELECT days, updated_at FROM session_retention WHERE id = 1").get() as
      | { days: number; updated_at: string }
      | undefined;
    return row ? { days: row.days, updatedAt: row.updated_at } : { days: 0, updatedAt: null };
  }

  setRetention(days: number): Retention {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_retention (id, days, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at`,
      )
      .run(days, now);
    return { days, updatedAt: now };
  }
}
