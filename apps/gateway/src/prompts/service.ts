import { randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest, conflict, notFound, PlatformError } from "../admin/errors.js";
import type { GatewayConfig } from "../config.js";
import type { PromptRenderInput, PromptService } from "../contracts.js";
import { type Db, migrate } from "../db.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default-prompt.js";
import { buildPromptVars, PROMPT_VARIABLES, type PromptVariable, renderPrompt, unknownVariables } from "./render.js";

const MIGRATIONS = [
  `CREATE TABLE prompts (
     name TEXT PRIMARY KEY,
     description TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE TABLE prompt_versions (
     name TEXT NOT NULL REFERENCES prompts(name) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     content TEXT NOT NULL,
     message TEXT NOT NULL DEFAULT '',
     author TEXT NOT NULL,
     created_at TEXT NOT NULL,
     sha TEXT NOT NULL,
     PRIMARY KEY (name, version)
   );
   CREATE TRIGGER prompt_versions_append_only BEFORE UPDATE ON prompt_versions
   BEGIN SELECT RAISE(ABORT, 'prompt_versions is append-only'); END;
   CREATE TABLE prompt_deployments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     action TEXT NOT NULL,
     name TEXT,
     version INTEGER,
     sha TEXT,
     actor TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     from_name TEXT,
     from_version INTEGER,
     revision TEXT NOT NULL
   );
   CREATE TABLE prompt_live (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     name TEXT,
     version INTEGER,
     revision TEXT NOT NULL,
     deployed_at TEXT NOT NULL,
     deployed_by TEXT NOT NULL
   );
   INSERT INTO prompt_live (id, name, version, revision, deployed_at, deployed_by)
   VALUES (1, NULL, NULL, lower(hex(randomblob(8))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system');`,
  // 관리 화면은 행위자를 보내지 않아 늘 "admin"이었다. sha는 읽는 곳이 없었다.
  `ALTER TABLE prompts DROP COLUMN created_by;
   ALTER TABLE prompt_versions DROP COLUMN author;
   ALTER TABLE prompt_versions DROP COLUMN sha;
   ALTER TABLE prompt_deployments DROP COLUMN actor;
   ALTER TABLE prompt_deployments DROP COLUMN sha;
   ALTER TABLE prompt_live DROP COLUMN deployed_by;`,
] as const;

export const PROMPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_PROMPT_CHARS = 200_000;

const PromptName = z.string().regex(PROMPT_NAME_PATTERN, "이름은 영문·숫자·_·- 64자 이하여야 합니다");
const Content = z.string().min(1, "내용이 비어 있습니다").max(MAX_PROMPT_CHARS, `최대 ${MAX_PROMPT_CHARS}자입니다`);
const Message = z.string().max(200).default("");
const Description = z.string().max(500).default("");
const Note = z.string().max(500).default("");

export const CreatePromptInput = z.object({ name: PromptName, description: Description, content: Content, message: Message });
export const AddVersionInput = z.object({ content: Content, message: Message });
export const DeployInput = z.object({ version: z.number().int().min(1), note: Note });
export const ResetInput = z.object({ note: Note });
export const RenderInput = z.object({ content: z.string().max(MAX_PROMPT_CHARS).optional() });

export interface PromptVersion {
  version: number;
  content: string;
  message: string;
  createdAt: string;
}

export interface PromptSummary {
  name: string;
  description: string;
  latestVersion: number;
  liveVersion: number | null;
}

export interface PromptDetail {
  name: string;
  description: string;
  liveVersion: number | null;
  versions: PromptVersion[];
}

export interface LivePrompt {
  name: string | null;
  version: number | null;
  revision: string;
  deployedAt: string;
  isDefault: boolean;
  /** 렌더링 전 템플릿 */
  content: string;
}

export interface PromptDeployment {
  id: number;
  at: string;
  action: "deploy" | "rollback" | "reset";
  name: string | null;
  version: number | null;
  note: string;
  fromName: string | null;
  fromVersion: number | null;
}

interface LiveRow {
  name: string | null;
  version: number | null;
  revision: string;
  deployed_at: string;
}

interface VersionRow {
  version: number;
  content: string;
  message: string;
  created_at: string;
}

const now = () => new Date().toISOString();
const newRevision = () => randomBytes(8).toString("hex");

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), result.error.issues);
  }
  return result.data;
}

/** 시스템 프롬프트 저장소와 배포 상태. PromptService(세션용)와 관리 API를 함께 제공한다. */
export class PromptManager implements PromptService {
  readonly #db: Db;
  readonly #language: string;

  constructor(db: Db, config: Pick<GatewayConfig, "prompts">) {
    this.#db = db;
    this.#language = config.prompts.language;
    migrate(db, "prompts", MIGRATIONS);
  }

  // ── 세션용 ─────────────────────────────────────────────────────

  snapshotForSession(input: PromptRenderInput): string {
    return renderPrompt(this.live().content, buildPromptVars(input, this.#language));
  }

  // ── 조회 ───────────────────────────────────────────────────────

  live(): LivePrompt {
    const live = this.#liveRow();
    const row = live.name !== null && live.version !== null ? this.#versionRow(live.name, live.version) : undefined;
    return {
      name: row ? live.name : null,
      version: row ? live.version : null,
      revision: live.revision,
      deployedAt: live.deployed_at,
      isDefault: !row,
      content: row?.content ?? DEFAULT_SYSTEM_PROMPT,
    };
  }

  list(): { live: LivePrompt; prompts: PromptSummary[]; defaultContent: string; variables: readonly PromptVariable[] } {
    const live = this.#liveRow();
    const rows = this.#db
      .prepare(
        `SELECT p.name, p.description, max(v.version) AS latest_version
           FROM prompts p JOIN prompt_versions v ON v.name = p.name
          GROUP BY p.name ORDER BY p.name`,
      )
      .all() as { name: string; description: string; latest_version: number }[];
    return {
      live: this.live(),
      defaultContent: DEFAULT_SYSTEM_PROMPT,
      variables: PROMPT_VARIABLES,
      prompts: rows.map((r) => ({
        name: r.name,
        description: r.description,
        latestVersion: r.latest_version,
        liveVersion: live.name === r.name ? live.version : null,
      })),
    };
  }

  get(name: string): PromptDetail {
    const prompt = this.#db.prepare("SELECT name, description FROM prompts WHERE name = ?").get(name) as
      | { name: string; description: string }
      | undefined;
    if (!prompt) throw notFound(`prompt '${name}' not found`);
    const versions = (
      this.#db
        .prepare("SELECT version, content, message, created_at FROM prompt_versions WHERE name = ? ORDER BY version")
        .all(name) as VersionRow[]
    ).map(toVersion);
    const live = this.#liveRow();
    return {
      name: prompt.name,
      description: prompt.description,
      liveVersion: live.name === name ? live.version : null,
      versions,
    };
  }

  deployments(limit = 50): PromptDeployment[] {
    const rows = this.#db
      .prepare(
        `SELECT id, at, action, name, version, note, from_name, from_version
           FROM prompt_deployments ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as {
      id: number;
      at: string;
      action: PromptDeployment["action"];
      name: string | null;
      version: number | null;
      note: string;
      from_name: string | null;
      from_version: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      name: r.name,
      version: r.version,
      note: r.note,
      fromName: r.from_name,
      fromVersion: r.from_version,
    }));
  }

  /** 미리보기. content가 없으면 현재 배포본을 렌더링한다. */
  render(input: unknown): { text: string; unknown: string[] } {
    const template = parse(RenderInput, input ?? {}).content ?? this.live().content;
    const text = renderPrompt(template, buildPromptVars({ user: "preview-user", model: "model", now: new Date() }, this.#language));
    return { text, unknown: unknownVariables(template) };
  }

  // ── 변경 ───────────────────────────────────────────────────────

  create(input: unknown): PromptDetail {
    const req = parse(CreatePromptInput, input);
    const at = now();
    this.#db.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM prompts WHERE name = ?").get(req.name)) throw conflict("exists", `prompt '${req.name}' already exists`);
      this.#db
        .prepare("INSERT INTO prompts (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(req.name, req.description, at, at);
      this.#insertVersion(req.name, 1, req.content, req.message || "처음 만듦", at);
    })();
    return this.get(req.name);
  }

  addVersion(name: string, input: unknown): PromptVersion {
    const req = parse(AddVersionInput, input);
    const at = now();
    let created: PromptVersion | undefined;
    this.#db.transaction(() => {
      const latest = this.#db
        .prepare("SELECT version, content FROM prompt_versions WHERE name = ? ORDER BY version DESC LIMIT 1")
        .get(name) as { version: number; content: string } | undefined;
      if (!latest) throw notFound(`prompt '${name}' not found`);
      if (latest.content === req.content) throw new PlatformError(422, "no_change", "content is identical to the latest version");
      created = this.#insertVersion(name, latest.version + 1, req.content, req.message, at);
    })();
    return created!;
  }

  deploy(name: string, input: unknown): { live: LivePrompt } {
    const req = parse(DeployInput, input);
    this.#db.transaction(() => {
      const live = this.#liveRow();
      if (!this.#versionRow(name, req.version)) throw notFound(`prompt '${name}' v${req.version} not found`);
      if (live.name === name && live.version === req.version) return; // 이미 배포된 버전
      const action = live.name === name && live.version !== null && req.version < live.version ? "rollback" : "deploy";
      this.#setLive(live, { name, version: req.version }, action, req.note);
    })();
    return { live: this.live() };
  }

  reset(input: unknown): { live: LivePrompt } {
    const req = parse(ResetInput, input ?? {});
    this.#db.transaction(() => {
      const live = this.#liveRow();
      if (live.name === null) return; // 이미 기본 프롬프트
      this.#setLive(live, { name: null, version: null }, "reset", req.note);
    })();
    return { live: this.live() };
  }

  // ── 내부 ───────────────────────────────────────────────────────

  #liveRow(): LiveRow {
    const row = this.#db.prepare("SELECT name, version, revision, deployed_at FROM prompt_live WHERE id = 1").get() as
      | LiveRow
      | undefined;
    if (!row) throw new Error("prompt_live row is missing");
    return row;
  }

  #versionRow(name: string, version: number): VersionRow | undefined {
    return this.#db
      .prepare("SELECT version, content, message, created_at FROM prompt_versions WHERE name = ? AND version = ?")
      .get(name, version) as VersionRow | undefined;
  }

  #insertVersion(name: string, version: number, content: string, message: string, at: string): PromptVersion {
    this.#db.prepare("INSERT INTO prompt_versions (name, version, content, message, created_at) VALUES (?, ?, ?, ?, ?)").run(name, version, content, message, at);
    return { version, content, message, createdAt: at };
  }

  #setLive(
    previous: LiveRow,
    next: { name: string | null; version: number | null },
    action: PromptDeployment["action"],
    note: string,
  ): void {
    const at = now();
    const revision = newRevision();
    this.#db
      .prepare("UPDATE prompt_live SET name = ?, version = ?, revision = ?, deployed_at = ? WHERE id = 1")
      .run(next.name, next.version, revision, at);
    this.#db
      .prepare(
        `INSERT INTO prompt_deployments (at, action, name, version, note, from_name, from_version, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, action, next.name, next.version, note, previous.name, previous.version, revision);
  }
}

function toVersion(row: VersionRow): PromptVersion {
  return {
    version: row.version,
    content: row.content,
    message: row.message,
    createdAt: row.created_at,
  };
}
