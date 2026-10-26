import type { McpRunIn, McpServerConfig } from "@pi-gateway/shared";
import { type Db, migrate } from "../db.js";
import type { AgentRecord, CommandRecord, SkillRecord, UnsupportedComponent } from "./components.js";
import type { JsonObject } from "./manifest.js";
import type { MarketplaceManifest } from "./marketplace.js";

const MIGRATIONS = [
  `CREATE TABLE plugin_marketplaces (
     name TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     ref TEXT,
     commit_sha TEXT NOT NULL,
     local_path TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     added_at TEXT NOT NULL,
     refreshed_at TEXT NOT NULL,
     added_by TEXT NOT NULL
   );
   CREATE TABLE plugins (
     id TEXT PRIMARY KEY,
     marketplace TEXT NOT NULL,
     name TEXT NOT NULL,
     version TEXT NOT NULL,
     install_path TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     source_json TEXT NOT NULL,
     manifest_json TEXT,
     components_json TEXT NOT NULL,
     mcp_json TEXT NOT NULL,
     installed_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     installed_by TEXT NOT NULL
   );
   CREATE TABLE platform_settings (
     key TEXT PRIMARY KEY,
     value_json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   );
   INSERT INTO platform_settings (key, value_json, updated_at, updated_by)
   VALUES ('plugins.revision', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system');`,
] as const;

export interface ResolvedSource {
  type: "relative" | "github" | "url" | "git-subdir";
  display: string;
  url?: string;
  ref?: string;
  sha?: string;
  path?: string;
  /** 설치한 커밋 (relative면 marketplace 커밋) */
  commit?: string;
}

export interface McpRecord {
  /** plugin 안에서의 서버 이름 */
  name: string;
  id?: string;
  runIn?: McpRunIn;
  status: "registered" | "unsupported" | "error" | "broker_unavailable";
  reason?: string;
  requiredSecrets: string[];
  /** broker 서버: 등록 직후 아직 값이 없는 비밀키 */
  missingSecrets?: string[];
  warnings: string[];
  /** 이번 설치 때의 매핑 결과 (관리자 수정 전). 다음 업데이트에서 관리자가 바꾼 값을 가려내는 기준이다. */
  baseline?: McpServerConfig;
}

export interface StoredComponents {
  skills: SkillRecord[];
  commands: CommandRecord[];
  agents: AgentRecord[];
  unsupported: UnsupportedComponent[];
  warnings: string[];
  copySkipped: { path: string; reason: string }[];
}

export interface MarketplaceRecord {
  name: string;
  url: string;
  ref: string | null;
  commitSha: string;
  localPath: string;
  manifest: MarketplaceManifest;
  addedAt: string;
  refreshedAt: string;
  addedBy: string;
}

export interface PluginRecord {
  id: string;
  marketplace: string;
  name: string;
  version: string;
  installPath: string;
  enabled: boolean;
  source: ResolvedSource;
  manifest: JsonObject | null;
  components: StoredComponents;
  mcp: McpRecord[];
  installedAt: string;
  updatedAt: string;
  installedBy: string;
}

interface MarketplaceRow {
  name: string;
  url: string;
  ref: string | null;
  commit_sha: string;
  local_path: string;
  manifest_json: string;
  added_at: string;
  refreshed_at: string;
  added_by: string;
}

interface PluginRow {
  id: string;
  marketplace: string;
  name: string;
  version: string;
  install_path: string;
  enabled: number;
  source_json: string;
  manifest_json: string | null;
  components_json: string;
  mcp_json: string;
  installed_at: string;
  updated_at: string;
  installed_by: string;
}

const now = () => new Date().toISOString();

export class PluginStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    migrate(db, "plugins", MIGRATIONS);
  }

  // ── marketplace ──

  listMarketplaces(): MarketplaceRecord[] {
    return (this.#db.prepare("SELECT * FROM plugin_marketplaces ORDER BY name").all() as MarketplaceRow[]).map(toMarketplace);
  }

  getMarketplace(name: string): MarketplaceRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM plugin_marketplaces WHERE name = ?").get(name) as MarketplaceRow | undefined;
    return row ? toMarketplace(row) : undefined;
  }

  upsertMarketplace(record: Omit<MarketplaceRecord, "addedAt" | "refreshedAt"> & { addedAt?: string }): void {
    const at = now();
    this.#db
      .prepare(
        `INSERT INTO plugin_marketplaces (name, url, ref, commit_sha, local_path, manifest_json, added_at, refreshed_at, added_by)
         VALUES (@name, @url, @ref, @commit, @path, @manifest, @addedAt, @at, @by)
         ON CONFLICT(name) DO UPDATE SET url = @url, ref = @ref, commit_sha = @commit, local_path = @path,
           manifest_json = @manifest, refreshed_at = @at`,
      )
      .run({
        name: record.name,
        url: record.url,
        ref: record.ref,
        commit: record.commitSha,
        path: record.localPath,
        manifest: JSON.stringify(record.manifest),
        addedAt: record.addedAt ?? at,
        at,
        by: record.addedBy,
      });
  }

  deleteMarketplace(name: string): boolean {
    return this.#db.prepare("DELETE FROM plugin_marketplaces WHERE name = ?").run(name).changes > 0;
  }

  // ── plugin ──

  listPlugins(): PluginRecord[] {
    return (this.#db.prepare("SELECT * FROM plugins ORDER BY id").all() as PluginRow[]).map(toPlugin);
  }

  getPlugin(id: string): PluginRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as PluginRow | undefined;
    return row ? toPlugin(row) : undefined;
  }

  upsertPlugin(record: Omit<PluginRecord, "installedAt" | "updatedAt">): void {
    const at = now();
    this.#db
      .prepare(
        `INSERT INTO plugins (id, marketplace, name, version, install_path, enabled, source_json, manifest_json,
                              components_json, mcp_json, installed_at, updated_at, installed_by)
         VALUES (@id, @marketplace, @name, @version, @path, @enabled, @source, @manifest, @components, @mcp, @at, @at, @by)
         ON CONFLICT(id) DO UPDATE SET version = @version, install_path = @path, enabled = @enabled, source_json = @source,
           manifest_json = @manifest, components_json = @components, mcp_json = @mcp, updated_at = @at, installed_by = @by`,
      )
      .run({
        id: record.id,
        marketplace: record.marketplace,
        name: record.name,
        version: record.version,
        path: record.installPath,
        enabled: record.enabled ? 1 : 0,
        source: JSON.stringify(record.source),
        manifest: record.manifest === null ? null : JSON.stringify(record.manifest),
        components: JSON.stringify(record.components),
        mcp: JSON.stringify(record.mcp),
        at,
        by: record.installedBy,
      });
  }

  setPluginMcp(id: string, mcp: McpRecord[]): void {
    this.#db.prepare("UPDATE plugins SET mcp_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(mcp), now(), id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.#db.prepare("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id).changes > 0;
  }

  deletePlugin(id: string): boolean {
    return this.#db.prepare("DELETE FROM plugins WHERE id = ?").run(id).changes > 0;
  }

  // ── 설정과 revision ──

  getSetting<T>(key: string, fallback: T): T {
    const row = this.#db.prepare("SELECT value_json FROM platform_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown, actor: string): void {
    this.#db
      .prepare(
        `INSERT INTO platform_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, JSON.stringify(value), now(), actor);
  }

  revision(): number {
    return this.getSetting("plugins.revision", 1);
  }

  bumpRevision(): number {
    const next = this.revision() + 1;
    this.setSetting("plugins.revision", next, "system");
    return next;
  }
}

function toMarketplace(row: MarketplaceRow): MarketplaceRecord {
  return {
    name: row.name,
    url: row.url,
    ref: row.ref,
    commitSha: row.commit_sha,
    localPath: row.local_path,
    manifest: JSON.parse(row.manifest_json) as MarketplaceManifest,
    addedAt: row.added_at,
    refreshedAt: row.refreshed_at,
    addedBy: row.added_by,
  };
}

function toPlugin(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    marketplace: row.marketplace,
    name: row.name,
    version: row.version,
    installPath: row.install_path,
    enabled: row.enabled === 1,
    source: JSON.parse(row.source_json) as ResolvedSource,
    manifest: row.manifest_json === null ? null : (JSON.parse(row.manifest_json) as JsonObject),
    components: JSON.parse(row.components_json) as StoredComponents,
    mcp: JSON.parse(row.mcp_json) as McpRecord[],
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    installedBy: row.installed_by,
  };
}
