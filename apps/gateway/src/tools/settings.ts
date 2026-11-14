import { DEFAULT_MAX_TOOL_CALLS_PER_TURN } from "../agent/tool-call-limit.js";
import { type Db, migrate } from "../db.js";

/**
 * 관리 화면에서 끈 기본 도구. 꺼진 도구는 세션(하위 agent 포함)을 열 때 뺀다.
 * 바꾸면 revision이 올라가고, 메모리의 세션은 다음 턴에 새 설정으로 다시 연다 (SessionHub).
 * MCP 도구는 여기서 끄지 않는다 (MCP 서버 설정의 enabled).
 *
 * 턴당 도구 호출 상한도 여기 있다. 턴(하위 agent는 호출)을 시작할 때 읽으므로 다음 턴부터 적용되고,
 * 모델에게 가는 것이 바뀌지 않아 세션을 다시 열지 않는다 (revision은 그대로다).
 */

const MIGRATIONS = [
  `CREATE TABLE disabled_tools (
     name TEXT PRIMARY KEY,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  // 관리 화면은 행위자를 보내지 않아 늘 "admin"이었다.
  `ALTER TABLE disabled_tools DROP COLUMN updated_by`,
  // 행이 없으면 기본값이다.
  `CREATE TABLE tool_call_limit (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     value INTEGER NOT NULL
   )`,
];

export class ToolSettings {
  #revision = 0;

  constructor(private readonly db: Db) {
    migrate(db, "tool-settings", MIGRATIONS);
  }

  disabled(): Set<string> {
    return new Set((this.db.prepare("SELECT name FROM disabled_tools").all() as { name: string }[]).map((r) => r.name));
  }

  setEnabled(name: string, enabled: boolean): void {
    const { changes } = enabled
      ? this.db.prepare("DELETE FROM disabled_tools WHERE name = ?").run(name)
      : this.db.prepare("INSERT OR IGNORE INTO disabled_tools (name, updated_at) VALUES (?, ?)").run(name, new Date().toISOString());
    if (changes > 0) this.#revision++;
  }

  /** 한 턴에서 모델이 부를 수 있는 도구 호출 수 */
  maxToolCalls(): number {
    const row = this.db.prepare("SELECT value FROM tool_call_limit WHERE id = 1").get() as { value: number } | undefined;
    return row?.value ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  }

  setMaxToolCalls(value: number): void {
    this.db.prepare("INSERT INTO tool_call_limit (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value").run(value);
  }

  /** 꺼진 도구가 바뀔 때마다 1씩 오른다 */
  revision(): number {
    return this.#revision;
  }
}
