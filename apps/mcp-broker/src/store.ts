import { collectTemplateRefs, McpServerConfig, requiredSecretNames } from "@pi-gateway/shared";
import { SecretCipher } from "./crypto.js";
import { type Db, migrate } from "./db.js";

const MIGRATIONS = [
  `CREATE TABLE servers (
     id TEXT PRIMARY KEY,
     config TEXT NOT NULL,
     revision INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE secrets (
     server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     version INTEGER NOT NULL,
     iv BLOB NOT NULL,
     ciphertext BLOB NOT NULL,
     tag BLOB NOT NULL,
     fingerprint TEXT NOT NULL,
     set_at TEXT NOT NULL,
     PRIMARY KEY (server_id, name)
   )`,
  `CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     server_id TEXT,
     detail TEXT
   )`,
  // 비밀키 버전은 행이 지워져도 줄어들지 않게 따로 기록한다 (AAD 재사용 방지).
  `CREATE TABLE secret_versions (
     server_id TEXT NOT NULL,
     name TEXT NOT NULL,
     last_version INTEGER NOT NULL,
     PRIMARY KEY (server_id, name)
   )`,
] as const;

export interface StoredServer {
  config: McpServerConfig;
  /** 설정이나 비밀키가 바뀔 때마다 증가한다. 풀은 이 값이 다른 연결을 다시 쓰지 않는다. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecretMeta {
  name: string;
  version: number;
  setAt: string;
  fingerprint: string;
}

export interface AuditRecord {
  at: string;
  actor: string;
  action: string;
  serverId?: string;
  detail?: string;
}

interface ServerRow {
  id: string;
  config: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SecretRow {
  server_id: string;
  name: string;
  version: number;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  fingerprint: string;
  set_at: string;
}

export class BrokerStore {
  readonly #db: Db;
  readonly #cipher: SecretCipher;

  constructor(db: Db, cipher: SecretCipher) {
    this.#db = db;
    this.#cipher = cipher;
    migrate(db, "mcp-broker", MIGRATIONS);
  }

  #toServer(row: ServerRow): StoredServer {
    return {
      config: McpServerConfig.parse(JSON.parse(row.config)),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listServers(): StoredServer[] {
    const rows = this.#db.prepare("SELECT * FROM servers ORDER BY id").all() as ServerRow[];
    return rows.map((row) => this.#toServer(row));
  }

  getServer(id: string): StoredServer | undefined {
    const row = this.#db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;
    return row ? this.#toServer(row) : undefined;
  }

  /**
   * 서버를 만들거나 고친다. 비밀값이 가는 곳(transportTarget)이 바뀌면 저장된 비밀값을 모두 지운다.
   * 관리 토큰을 가진 사람이 url이나 헤더를 공격자 쪽으로 바꿔 기존 비밀값을 빼내지 못하게 하려는 것이다.
   * 표시 이름·timeout·도구 필터 같은 변경은 비밀값을 그대로 둔다.
   */
  upsertServer(config: McpServerConfig): { server: StoredServer; created: boolean; clearedSecrets: string[] } {
    const now = new Date().toISOString();
    return this.#db.transaction(() => {
      const existing = this.#db.prepare("SELECT config FROM servers WHERE id = ?").get(config.id) as
        | { config: string }
        | undefined;
      let clearedSecrets: string[] = [];
      if (existing) {
        const previous = McpServerConfig.parse(JSON.parse(existing.config));
        if (transportTarget(previous) !== transportTarget(config)) {
          clearedSecrets = (
            this.#db.prepare("SELECT name FROM secrets WHERE server_id = ? ORDER BY name").all(config.id) as { name: string }[]
          ).map((r) => r.name);
          this.#db.prepare("DELETE FROM secrets WHERE server_id = ?").run(config.id);
        }
        this.#db
          .prepare("UPDATE servers SET config = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(config), now, config.id);
      } else {
        this.#db
          .prepare("INSERT INTO servers (id, config, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
          .run(config.id, JSON.stringify(config), now, now);
      }
      return { server: this.getServer(config.id)!, created: !existing, clearedSecrets };
    })();
  }

  deleteServer(id: string): boolean {
    return this.#db.prepare("DELETE FROM servers WHERE id = ?").run(id).changes > 0;
  }

  #bumpRevision(serverId: string): void {
    this.#db
      .prepare("UPDATE servers SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), serverId);
  }

  listSecretMeta(serverId: string): SecretMeta[] {
    const rows = this.#db
      .prepare("SELECT name, version, set_at, fingerprint FROM secrets WHERE server_id = ? ORDER BY name")
      .all(serverId) as Pick<SecretRow, "name" | "version" | "set_at" | "fingerprint">[];
    return rows.map((r) => ({ name: r.name, version: r.version, setAt: r.set_at, fingerprint: r.fingerprint }));
  }

  /** 값을 암호화해 저장한다. 서버가 없으면 undefined. */
  putSecret(serverId: string, name: string, value: string): SecretMeta | undefined {
    return this.#db.transaction(() => {
      if (!this.#db.prepare("SELECT 1 FROM servers WHERE id = ?").get(serverId)) return undefined;
      const last = this.#db
        .prepare("SELECT last_version FROM secret_versions WHERE server_id = ? AND name = ?")
        .get(serverId, name) as { last_version: number } | undefined;
      const version = (last?.last_version ?? 0) + 1;
      this.#db
        .prepare(
          `INSERT INTO secret_versions (server_id, name, last_version) VALUES (?, ?, ?)
           ON CONFLICT (server_id, name) DO UPDATE SET last_version = excluded.last_version`,
        )
        .run(serverId, name, version);
      const enc = this.#cipher.encrypt(value, SecretCipher.aad(serverId, name, version));
      const fingerprint = this.#cipher.fingerprint(value);
      const setAt = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO secrets (server_id, name, version, iv, ciphertext, tag, fingerprint, set_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (server_id, name) DO UPDATE SET
             version = excluded.version, iv = excluded.iv, ciphertext = excluded.ciphertext,
             tag = excluded.tag, fingerprint = excluded.fingerprint, set_at = excluded.set_at`,
        )
        .run(serverId, name, version, enc.iv, enc.ciphertext, enc.tag, fingerprint, setAt);
      this.#bumpRevision(serverId);
      return { name, version, setAt, fingerprint };
    })();
  }

  deleteSecret(serverId: string, name: string): boolean {
    return this.#db.transaction(() => {
      const removed = this.#db.prepare("DELETE FROM secrets WHERE server_id = ? AND name = ?").run(serverId, name).changes > 0;
      if (removed) this.#bumpRevision(serverId);
      return removed;
    })();
  }

  /** 서버의 비밀값을 복호화한다. 복호화에 실패한 값(변조·KEK 불일치)은 빠지고 failed에 이름이 담긴다. */
  resolveSecrets(serverId: string): { values: Map<string, string>; failed: string[] } {
    const rows = this.#db.prepare("SELECT * FROM secrets WHERE server_id = ?").all(serverId) as SecretRow[];
    const values = new Map<string, string>();
    const failed: string[] = [];
    for (const row of rows) {
      try {
        values.set(
          row.name,
          this.#cipher.decrypt(
            { iv: row.iv, ciphertext: row.ciphertext, tag: row.tag },
            SecretCipher.aad(row.server_id, row.name, row.version),
          ),
        );
      } catch {
        failed.push(row.name);
      }
    }
    return { values, failed };
  }

  /** 설정이 참조하지만 저장되지 않은 비밀키 이름 */
  missingSecrets(server: StoredServer): string[] {
    const present = new Set(this.listSecretMeta(server.config.id).map((s) => s.name));
    return requiredSecretNames(server.config).filter((name) => !present.has(name));
  }

  addAudit(record: Omit<AuditRecord, "at">): void {
    this.#db
      .prepare("INSERT INTO audit (at, actor, action, server_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), record.actor, record.action, record.serverId ?? null, record.detail ?? null);
  }

  listAudit(limit: number): AuditRecord[] {
    const rows = this.#db
      .prepare("SELECT at, actor, action, server_id, detail FROM audit ORDER BY id DESC LIMIT ?")
      .all(limit) as { at: string; actor: string; action: string; server_id: string | null; detail: string | null }[];
    return rows.map((r) => {
      const out: AuditRecord = { at: r.at, actor: r.actor, action: r.action };
      if (r.server_id !== null) out.serverId = r.server_id;
      if (r.detail !== null) out.detail = r.detail;
      return out;
    });
  }
}

/**
 * 비밀값이 어디로 가는지를 나타내는 정규화된 문자열. 이 값이 바뀌면 저장된 비밀값을 지운다.
 * - stdio: 실행 명령·인자·cwd·env 전체 (env의 다른 값으로도 비밀값의 행선지를 바꿀 수 있다)
 * - http: url의 origin, 헤더 전체, url 안에서 쓰는 비밀키 이름
 */
export function transportTarget(config: Pick<McpServerConfig, "transport">): string {
  const t = config.transport;
  if (t.type === "stdio") {
    const env = Object.entries(t.env).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify({ type: "stdio", command: t.command, args: t.args, cwd: t.cwd ?? null, env });
  }
  let origin: string;
  try {
    // 자리표시자가 host에 들어 있으면 그 자체가 행선지를 바꿀 수 있으므로 문자 그대로 비교한다.
    origin = /\{\{/.test(t.url.split("/").slice(0, 3).join("/")) ? t.url : new URL(t.url).origin;
  } catch {
    origin = t.url;
  }
  const headers = Object.entries(t.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const urlSecrets = collectTemplateRefs({ transport: { ...t, headers: {} } })
    .refs.filter((r) => r.kind === "secret")
    .map((r) => (r.kind === "secret" ? r.name : ""))
    .sort();
  return JSON.stringify({ type: "http", origin, headers, urlSecrets });
}
