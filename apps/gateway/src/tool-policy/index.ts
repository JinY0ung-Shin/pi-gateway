import type { GatewayConfig } from "../config.js";
import type { ToolCatalogEntry, ToolPolicy } from "../contracts.js";
import { type Db, migrate } from "../db.js";

const MIGRATIONS = [
  `CREATE TABLE tool_settings (
     name TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE tool_policy_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     revision INTEGER NOT NULL
   );
   INSERT INTO tool_policy_meta (id, revision) VALUES (1, 1);`,
] as const;

export interface ToolSetting {
  name: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

/** `mcp__<server>__*` — MCP 서버 하나의 도구 전체를 가리키는 대표 이름 */
export const MCP_WILDCARD = /^mcp__([a-z0-9][a-z0-9_-]{0,47})__\*$/;
const MCP_TOOL = /^mcp__([a-z0-9][a-z0-9_-]{0,47})__(.+)$/;

/** MCP 도구 이름에 해당하는 서버 대표 이름 (`mcp__github__create_issue` → `mcp__github__*`) */
export function mcpWildcardFor(name: string): string | undefined {
  if (MCP_WILDCARD.test(name)) return undefined;
  const match = MCP_TOOL.exec(name);
  return match ? `mcp__${match[1]}__*` : undefined;
}

/**
 * 관리자가 정한 도구 켜기/끄기.
 * - required 도구는 항상 켜져 있다.
 * - 그 밖에는 도구 이름의 설정 → (MCP 도구면) 서버 대표 이름 `mcp__<server>__*`의 설정 → enabledByDefault 순으로 본다.
 * - 상태는 DB에 있으므로 여러 인스턴스를 만들어도 결과가 같다.
 */
export class ToolPolicyService implements ToolPolicy {
  readonly #db: Db;
  #cache: { revision: number; settings: Map<string, ToolSetting> } | undefined;

  constructor(db: Db) {
    this.#db = db;
    migrate(db, "tool-policy", MIGRATIONS);
  }

  isEnabled(entry: Pick<ToolCatalogEntry, "name" | "provider" | "enabledByDefault" | "required">, _principal: string): boolean {
    if (entry.required) return true;
    const settings = this.#settings();
    const own = settings.get(entry.name);
    if (own) return own.enabled;
    const wildcard = mcpWildcardFor(entry.name);
    const server = wildcard ? settings.get(wildcard) : undefined;
    if (server) return server.enabled;
    return entry.enabledByDefault;
  }

  revision(): number {
    const row = this.#db.prepare("SELECT revision FROM tool_policy_meta WHERE id = 1").get() as { revision: number } | undefined;
    return row?.revision ?? 1;
  }

  get(name: string): ToolSetting | undefined {
    return this.#settings().get(name);
  }

  list(): ToolSetting[] {
    return [...this.#settings().values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  set(name: string, enabled: boolean, actor: string): ToolSetting {
    const at = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO tool_settings (name, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(name, enabled ? 1 : 0, actor, at);
      this.#bump();
    })();
    return { name, enabled, updatedBy: actor, updatedAt: at };
  }

  /** 설정을 지워 기본값으로 되돌린다. 설정이 없었으면 false. */
  reset(name: string): boolean {
    let removed = false;
    this.#db.transaction(() => {
      removed = this.#db.prepare("DELETE FROM tool_settings WHERE name = ?").run(name).changes > 0;
      if (removed) this.#bump();
    })();
    return removed;
  }

  #bump(): void {
    this.#db.prepare("UPDATE tool_policy_meta SET revision = revision + 1 WHERE id = 1").run();
  }

  #settings(): Map<string, ToolSetting> {
    const revision = this.revision();
    if (this.#cache?.revision === revision) return this.#cache.settings;
    const rows = this.#db.prepare("SELECT name, enabled, updated_by, updated_at FROM tool_settings").all() as {
      name: string;
      enabled: number;
      updated_by: string;
      updated_at: string;
    }[];
    const settings = new Map(
      rows.map((r) => [r.name, { name: r.name, enabled: r.enabled === 1, updatedBy: r.updated_by, updatedAt: r.updated_at }]),
    );
    this.#cache = { revision, settings };
    return settings;
  }
}

/** core가 세션을 만들 때 쓰는 정책. 반환 객체는 관리 API용 메서드도 가진다. */
export function createToolPolicy(db: Db, _config: GatewayConfig): ToolPolicyService {
  return new ToolPolicyService(db);
}

export function isToolPolicyService(policy: ToolPolicy | undefined): policy is ToolPolicyService {
  return policy instanceof ToolPolicyService;
}
