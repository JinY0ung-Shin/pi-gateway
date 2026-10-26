import { type Db, migrate } from "../db.js";

/**
 * 관리 화면에서 끈 기본 도구. 꺼진 도구는 세션(하위 agent 포함)을 열 때 뺀다.
 * 바꾸면 revision이 올라가고, 메모리의 세션은 다음 턴에 새 설정으로 다시 연다 (SessionHub).
 * MCP 도구는 여기서 끄지 않는다 (MCP 서버 설정의 enabled).
 */

const MIGRATIONS = [
  `CREATE TABLE disabled_tools (
     name TEXT PRIMARY KEY,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
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

  setEnabled(name: string, enabled: boolean, actor: string): void {
    const { changes } = enabled
      ? this.db.prepare("DELETE FROM disabled_tools WHERE name = ?").run(name)
      : this.db.prepare("INSERT OR IGNORE INTO disabled_tools (name, updated_at, updated_by) VALUES (?, ?, ?)").run(name, new Date().toISOString(), actor);
    if (changes > 0) this.#revision++;
  }

  /** 설정이 바뀔 때마다 1씩 오른다 */
  revision(): number {
    return this.#revision;
  }
}
