import { McpServerConfig } from "@pi-gateway/shared";
import type { Logger } from "pino";
import { type Db, migrate } from "../db.js";

const MIGRATIONS = [
  `CREATE TABLE mcp_sandbox_servers (
     id TEXT PRIMARY KEY,
     config_json TEXT NOT NULL,
     plugin_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   );
   CREATE INDEX mcp_sandbox_servers_plugin ON mcp_sandbox_servers(plugin_id);
   -- broker에 있다고 마지막으로 확인한 서버 id. broker가 안 될 때 sandbox 변경이 id를 겹치게 만드는지 판단하는 데 쓴다.
   CREATE TABLE mcp_broker_ids (
     id TEXT PRIMARY KEY,
     seen_at TEXT NOT NULL
   );`,
  // broker가 필수가 되어 broker id를 기억할 필요가 없다 (broker가 안 되면 sandbox 서버 생성도 503).
  `DROP TABLE mcp_broker_ids`,
  // 관리 화면은 행위자를 보내지 않아 늘 "admin"이었다.
  `ALTER TABLE mcp_sandbox_servers DROP COLUMN updated_by`,
] as const;

interface Row {
  id: string;
  config_json: string;
}

/** gateway DB에 저장되는 sandbox 실행 MCP 서버 (비밀값이 없는 설정만 들어온다). */
export class SandboxServerStore {
  readonly #db: Db;
  readonly #log: Logger;

  constructor(db: Db, log: Logger) {
    this.#db = db;
    this.#log = log;
    migrate(db, "mcp-registry", MIGRATIONS);
  }

  list(): McpServerConfig[] {
    const rows = this.#db.prepare("SELECT id, config_json FROM mcp_sandbox_servers ORDER BY id").all() as Row[];
    const out: McpServerConfig[] = [];
    for (const row of rows) {
      const config = this.#parse(row);
      if (config) out.push(config);
    }
    return out;
  }

  get(id: string): McpServerConfig | undefined {
    const row = this.#db.prepare("SELECT id, config_json FROM mcp_sandbox_servers WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#parse(row) : undefined;
  }

  listByPlugin(pluginId: string): McpServerConfig[] {
    const rows = this.#db
      .prepare("SELECT id, config_json FROM mcp_sandbox_servers WHERE plugin_id = ? ORDER BY id")
      .all(pluginId) as Row[];
    return rows.map((r) => this.#parse(r)).filter((c): c is McpServerConfig => c !== undefined);
  }

  upsert(config: McpServerConfig): void {
    if (config.runIn !== "sandbox") throw new Error("only sandbox servers are stored in the gateway");
    const at = new Date().toISOString();
    const pluginId = config.source.kind === "plugin" ? config.source.pluginId : null;
    this.#db
      .prepare(
        `INSERT INTO mcp_sandbox_servers (id, config_json, plugin_id, created_at, updated_at)
         VALUES (@id, @config, @pluginId, @at, @at)
         ON CONFLICT(id) DO UPDATE SET config_json = @config, plugin_id = @pluginId, updated_at = @at`,
      )
      .run({ id: config.id, config: JSON.stringify(config), pluginId, at });
  }

  delete(id: string): boolean {
    return this.#db.prepare("DELETE FROM mcp_sandbox_servers WHERE id = ?").run(id).changes > 0;
  }

  #parse(row: Row): McpServerConfig | undefined {
    try {
      return McpServerConfig.parse(JSON.parse(row.config_json));
    } catch (error) {
      this.#log.warn({ id: row.id, err: String(error) }, "invalid sandbox MCP server config in DB; skipped");
      return undefined;
    }
  }
}
