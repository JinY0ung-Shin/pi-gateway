import { type Db, migrate } from "../db.js";

/** gateway가 기억하는 세션 메타. 대화 내용 자체는 pi JSONL에 있다. */

export interface PendingToolCall {
  call_id: string;
  name: string;
  arguments: unknown;
}

export interface PromptRef {
  name: string | null;
  version: number | null;
  revision: string;
}

export interface SessionRecord {
  id: string;
  principal: string;
  user: string;
  model: string;
  thinkingLevel: string;
  /** commit된 마지막 turn 번호 (0 = 아직 없음) */
  turn: number;
  /** pi JSONL 경로. 첫 메시지가 기록되기 전에는 null */
  sessionFile: string | null;
  /** commit 시점의 pi leaf entry id. 되살릴 때 이 지점으로 맞춘다 (실패한 턴을 버리기 위해). */
  leafId: string | null;
  promptText: string;
  promptRef: PromptRef;
  /** pi addendum: 첫 턴 instructions + `Current user:` */
  appendPrompt: string;
  /** 세션을 만들 때의 skill 이름 목록 (이후 설치된 skill은 새 세션부터) */
  skillNames: string[];
  pendingToolCall: PendingToolCall | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

interface Row {
  id: string;
  principal: string;
  user: string;
  model: string;
  thinking_level: string;
  turn: number;
  session_file: string | null;
  leaf_id: string | null;
  prompt_text: string;
  prompt_ref: string;
  append_prompt: string;
  skill_names: string;
  pending_tool_call: string | null;
  created_at: string;
  updated_at: string;
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
];

/** 대화 기록 보관 기간. 마지막 활동 뒤 days일이 지나면 지운다 (0 = 지우지 않는다). */
export interface Retention {
  days: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

function fromRow(row: Row): SessionRecord {
  return {
    id: row.id,
    principal: row.principal,
    user: row.user,
    model: row.model,
    thinkingLevel: row.thinking_level,
    turn: row.turn,
    sessionFile: row.session_file,
    leafId: row.leaf_id,
    promptText: row.prompt_text,
    promptRef: JSON.parse(row.prompt_ref) as PromptRef,
    appendPrompt: row.append_prompt,
    skillNames: JSON.parse(row.skill_names) as string[],
    pendingToolCall: row.pending_tool_call ? (JSON.parse(row.pending_tool_call) as PendingToolCall) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
        `INSERT INTO sessions (id, principal, user, model, thinking_level, turn, session_file, leaf_id, prompt_text, prompt_ref,
           append_prompt, skill_names, pending_tool_call, created_at, updated_at, last_active_at)
         VALUES (@id, @principal, @user, @model, @thinking_level, @turn, @session_file, @leaf_id, @prompt_text, @prompt_ref,
           @append_prompt, @skill_names, @pending_tool_call, @created_at, @updated_at, @last_active_at)`,
      )
      .run({
        id: record.id,
        principal: record.principal,
        user: record.user,
        model: record.model,
        thinking_level: record.thinkingLevel,
        turn: record.turn,
        session_file: record.sessionFile,
        leaf_id: record.leafId,
        prompt_text: record.promptText,
        prompt_ref: JSON.stringify(record.promptRef),
        append_prompt: record.appendPrompt,
        skill_names: JSON.stringify(record.skillNames),
        pending_tool_call: record.pendingToolCall ? JSON.stringify(record.pendingToolCall) : null,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        last_active_at: record.lastActiveAt,
      });
  }

  /** turn을 commit한다 (turn 번호, leaf, 대기 중인 질문, 세션 파일). */
  commit(
    id: string,
    patch: { turn: number; leafId: string | null; sessionFile: string | null; pendingToolCall: PendingToolCall | null },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET turn = ?, leaf_id = ?, session_file = COALESCE(?, session_file), pending_tool_call = ?,
           updated_at = ?, last_active_at = ? WHERE id = ?`,
      )
      .run(patch.turn, patch.leafId, patch.sessionFile, patch.pendingToolCall ? JSON.stringify(patch.pendingToolCall) : null, now, now, id);
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
    const row = this.db.prepare("SELECT days, updated_at, updated_by FROM session_retention WHERE id = 1").get() as
      | { days: number; updated_at: string; updated_by: string }
      | undefined;
    return row ? { days: row.days, updatedAt: row.updated_at, updatedBy: row.updated_by } : { days: 0, updatedAt: null, updatedBy: null };
  }

  setRetention(days: number, actor: string): Retention {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_retention (id, days, updated_at, updated_by) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(days, now, actor);
    return { days, updatedAt: now, updatedBy: actor };
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  }
}
