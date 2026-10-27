import { McpServerConfig, requiredSecretNames, transportTarget } from "@pi-gateway/shared";
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
  // broker는 stdio 서버를 더 실행하지 않는다. 남아 있던 stdio 서버와 그 비밀키를 지운다.
  `DELETE FROM servers WHERE json_extract(config, '$.transport.type') = 'stdio'`,
  // 감사 기록은 읽는 곳이 없어 로그("admin change")로 옮겼다.
  `DROP TABLE audit`,
] as const;

export interface StoredServer {
  config: McpServerConfig;
  /** 설정이 바뀔 때마다 증가한다 (변경 로그용). */
  revision: number;
}

export interface SecretMeta {
  name: string;
  version: number;
  setAt: string;
  fingerprint: string;
}

interface ServerRow {
  id: string;
  config: string;
  revision: number;
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
   * 관리 API를 부를 수 있는 쪽이 url이나 헤더를 공격자 쪽으로 바꿔 기존 비밀값을 빼내지 못하게 하려는 것이다.
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
      return { name, version, setAt, fingerprint };
    })();
  }

  deleteSecret(serverId: string, name: string): boolean {
    return this.#db.prepare("DELETE FROM secrets WHERE server_id = ? AND name = ?").run(serverId, name).changes > 0;
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
}

