import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest, conflict, notFound, PlatformError } from "../admin/errors.js";
import type { GatewayConfig } from "../config.js";
import type { PromptRenderInput, PromptService, PromptSnapshot } from "../contracts.js";
import { type Db, migrate } from "../db.js";
import { DEFAULT_SYSTEM_PROMPT } from "./default-prompt.js";
import { analyzePrompt, buildPromptVars, PROMPT_VARIABLES, type PromptVariable, renderPrompt } from "./render.js";

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
  // 삭제는 표시만 한다 (버전과 배포 이력이 가리키는 내용을 남기고, 같은 이름을 다시 쓰지 못하게 한다).
  `ALTER TABLE prompts ADD COLUMN deleted_at TEXT;
   ALTER TABLE prompts ADD COLUMN deleted_by TEXT;`,
] as const;

export const PROMPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_PROMPT_CHARS = 200_000;

const PromptName = z.string().regex(PROMPT_NAME_PATTERN, "이름은 영문·숫자·_·- 64자 이하여야 합니다");
const Content = z.string().min(1, "내용이 비어 있습니다").max(MAX_PROMPT_CHARS, `최대 ${MAX_PROMPT_CHARS}자입니다`);
const Message = z.string().max(200).default("");
const Description = z.string().max(500).default("");
const Note = z.string().max(500).default("");

export const CreatePromptInput = z.object({ name: PromptName, description: Description, content: Content, message: Message });
export const AddVersionInput = z.object({ content: Content, message: Message, baseVersion: z.number().int().min(0) });
export const DeployInput = z.object({
  version: z.number().int().min(1),
  note: Note,
  expectedRevision: z.string().optional(),
});
export const ResetInput = z.object({ note: Note, expectedRevision: z.string().optional() });
export const RenderInput = z.object({
  content: z.string().max(MAX_PROMPT_CHARS).optional(),
  name: PromptName.optional(),
  version: z.number().int().min(1).optional(),
  user: z.string().max(200).nullable().optional(),
  model: z.string().max(200).optional(),
});

export interface PromptVersion {
  version: number;
  content: string;
  message: string;
  author: string;
  createdAt: string;
  sha: string;
}

export interface PromptSummary {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  versionCount: number;
  latestAuthor: string;
  latestSha: string;
  charCount: number;
  liveVersion: number | null;
}

export interface PromptDetail extends Omit<PromptSummary, "latestAuthor" | "latestSha" | "charCount"> {
  createdBy: string;
  versions: PromptVersion[];
}

export interface LivePrompt {
  name: string | null;
  version: number | null;
  revision: string;
  deployedAt: string;
  deployedBy: string;
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
  sha: string | null;
  actor: string;
  note: string;
  fromName: string | null;
  fromVersion: number | null;
  revision: string;
}

interface LiveRow {
  name: string | null;
  version: number | null;
  revision: string;
  deployed_at: string;
  deployed_by: string;
}

interface VersionRow {
  version: number;
  content: string;
  message: string;
  author: string;
  created_at: string;
  sha: string;
}

const now = () => new Date().toISOString();
const newRevision = () => randomBytes(8).toString("hex");

export function normalizeActor(actor: string | undefined): string {
  const trimmed = (actor ?? "").trim().slice(0, 120);
  return trimmed || "admin";
}

function versionSha(name: string, version: number, content: string, author: string, createdAt: string, message: string) {
  return createHash("sha256").update(JSON.stringify([name, version, content, author, createdAt, message])).digest("hex");
}

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
  readonly #timeZone: string | undefined;

  constructor(db: Db, config: Pick<GatewayConfig, "prompts">, options: { timeZone?: string } = {}) {
    this.#db = db;
    this.#language = config.prompts.language;
    this.#timeZone = options.timeZone;
    migrate(db, "prompts", MIGRATIONS);
  }

  // ── 세션용 ─────────────────────────────────────────────────────

  snapshotForSession(input: PromptRenderInput): PromptSnapshot {
    const live = this.#liveRow();
    let template = DEFAULT_SYSTEM_PROMPT;
    let ref: PromptSnapshot["ref"] = { name: null, version: null, revision: live.revision };
    if (live.name !== null && live.version !== null) {
      const row = this.#versionRow(live.name, live.version);
      if (row) {
        template = row.content;
        ref = { name: live.name, version: live.version, revision: live.revision };
      }
    }
    return { text: renderPrompt(template, buildPromptVars(input, this.#language, this.#timeZone)), ref };
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
      deployedBy: live.deployed_by,
      isDefault: !row,
      content: row?.content ?? DEFAULT_SYSTEM_PROMPT,
    };
  }

  list(): { live: LivePrompt; prompts: PromptSummary[]; defaultContent: string; variables: readonly PromptVariable[] } {
    const live = this.#liveRow();
    const rows = this.#db
      .prepare(
        `SELECT p.name, p.description, p.created_at, p.updated_at,
                v.version AS latest_version, v.author AS latest_author, v.sha AS latest_sha,
                length(v.content) AS char_count,
                (SELECT count(*) FROM prompt_versions c WHERE c.name = p.name) AS version_count
           FROM prompts p
           JOIN prompt_versions v ON v.name = p.name
            AND v.version = (SELECT max(version) FROM prompt_versions m WHERE m.name = p.name)
          WHERE p.deleted_at IS NULL
          ORDER BY p.name`,
      )
      .all() as {
      name: string;
      description: string;
      created_at: string;
      updated_at: string;
      latest_version: number;
      latest_author: string;
      latest_sha: string;
      char_count: number;
      version_count: number;
    }[];
    return {
      live: this.live(),
      defaultContent: DEFAULT_SYSTEM_PROMPT,
      variables: PROMPT_VARIABLES,
      prompts: rows.map((r) => ({
        name: r.name,
        description: r.description,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        latestVersion: r.latest_version,
        versionCount: r.version_count,
        latestAuthor: r.latest_author,
        latestSha: r.latest_sha,
        charCount: r.char_count,
        liveVersion: live.name === r.name ? live.version : null,
      })),
    };
  }

  get(name: string): PromptDetail {
    const prompt = this.#db
      .prepare("SELECT name, description, created_at, updated_at, created_by FROM prompts WHERE name = ? AND deleted_at IS NULL")
      .get(name) as { name: string; description: string; created_at: string; updated_at: string; created_by: string } | undefined;
    if (!prompt) throw notFound(`prompt '${name}' not found`);
    const versions = (
      this.#db
        .prepare("SELECT version, content, message, author, created_at, sha FROM prompt_versions WHERE name = ? ORDER BY version")
        .all(name) as VersionRow[]
    ).map(toVersion);
    const live = this.#liveRow();
    return {
      name: prompt.name,
      description: prompt.description,
      createdAt: prompt.created_at,
      updatedAt: prompt.updated_at,
      createdBy: prompt.created_by,
      latestVersion: versions.at(-1)?.version ?? 0,
      versionCount: versions.length,
      liveVersion: live.name === name ? live.version : null,
      versions,
    };
  }

  deployments(limit = 50): PromptDeployment[] {
    const rows = this.#db
      .prepare(
        `SELECT id, at, action, name, version, sha, actor, note, from_name, from_version, revision
           FROM prompt_deployments ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as {
      id: number;
      at: string;
      action: PromptDeployment["action"];
      name: string | null;
      version: number | null;
      sha: string | null;
      actor: string;
      note: string;
      from_name: string | null;
      from_version: number | null;
      revision: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      name: r.name,
      version: r.version,
      sha: r.sha,
      actor: r.actor,
      note: r.note,
      fromName: r.from_name,
      fromVersion: r.from_version,
      revision: r.revision,
    }));
  }

  /** 미리보기. content가 없으면 name/version(또는 현재 배포본)을 렌더링한다. */
  render(input: unknown): { text: string; used: PromptVariable[]; unknown: string[]; charCount: number } {
    const req = parse(RenderInput, input ?? {});
    let template: string;
    if (req.content !== undefined) template = req.content;
    else if (req.name !== undefined) {
      const version = req.version ?? this.get(req.name).latestVersion;
      const row = this.#versionRow(req.name, version);
      if (!row) throw notFound(`prompt '${req.name}' v${version} not found`);
      template = row.content;
    } else template = this.live().content;
    const user = req.user === undefined ? "preview-user" : req.user;
    const text = renderPrompt(
      template,
      buildPromptVars(
        { principal: user ?? "_anon-preview", user, model: req.model ?? "model", sessionId: "preview", now: new Date() },
        this.#language,
        this.#timeZone,
      ),
    );
    const analysis = analyzePrompt(template);
    return { text, used: analysis.used, unknown: analysis.unknown, charCount: text.length };
  }

  // ── 변경 ───────────────────────────────────────────────────────

  create(input: unknown, actorInput?: string): PromptDetail {
    const req = parse(CreatePromptInput, input);
    const actor = normalizeActor(actorInput);
    const at = now();
    this.#db.transaction(() => {
      const exists = this.#db.prepare("SELECT deleted_at FROM prompts WHERE name = ?").get(req.name) as
        | { deleted_at: string | null }
        | undefined;
      if (exists?.deleted_at) {
        throw conflict("name_retired", `the name '${req.name}' belonged to a deleted prompt and cannot be reused (deployment history still points to it)`);
      }
      if (exists) throw conflict("exists", `prompt '${req.name}' already exists`);
      this.#db
        .prepare("INSERT INTO prompts (name, description, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?)")
        .run(req.name, req.description, at, at, actor);
      this.#insertVersion(req.name, 1, req.content, req.message || "처음 만듦", actor, at);
    })();
    return this.get(req.name);
  }

  updateDescription(name: string, description: unknown, actorInput?: string): PromptDetail {
    const value = parse(Description, description);
    normalizeActor(actorInput);
    const result = this.#db
      .prepare("UPDATE prompts SET description = ?, updated_at = ? WHERE name = ? AND deleted_at IS NULL")
      .run(value, now(), name);
    if (result.changes === 0) throw notFound(`prompt '${name}' not found`);
    return this.get(name);
  }

  /** 삭제 표시만 한다. 버전·배포 이력은 남고, 같은 이름으로 다시 만들 수 없다. */
  remove(name: string, actorInput?: string): void {
    const actor = normalizeActor(actorInput);
    this.#db.transaction(() => {
      const live = this.#liveRow();
      if (live.name === name) throw conflict("live", `prompt '${name}' is live; deploy another prompt or reset first`);
      const result = this.#db
        .prepare("UPDATE prompts SET deleted_at = ?, deleted_by = ? WHERE name = ? AND deleted_at IS NULL")
        .run(now(), actor, name);
      if (result.changes === 0) throw notFound(`prompt '${name}' not found`);
    })();
  }

  addVersion(name: string, input: unknown, actorInput?: string): PromptVersion {
    const req = parse(AddVersionInput, input);
    const actor = normalizeActor(actorInput);
    const at = now();
    let created: PromptVersion | undefined;
    this.#db.transaction(() => {
      if (!this.#isActive(name)) throw notFound(`prompt '${name}' not found`);
      const latest = this.#db
        .prepare("SELECT version, content FROM prompt_versions WHERE name = ? ORDER BY version DESC LIMIT 1")
        .get(name) as { version: number; content: string } | undefined;
      if (!latest) throw notFound(`prompt '${name}' not found`);
      if (req.baseVersion !== latest.version) {
        throw conflict("conflict", `prompt '${name}' was changed (latest is v${latest.version}, edit was based on v${req.baseVersion})`, {
          latestVersion: latest.version,
        });
      }
      if (latest.content === req.content) throw new PlatformError(422, "no_change", "content is identical to the latest version");
      created = this.#insertVersion(name, latest.version + 1, req.content, req.message, actor, at);
      this.#db.prepare("UPDATE prompts SET updated_at = ? WHERE name = ?").run(at, name);
    })();
    return created!;
  }

  deploy(name: string, input: unknown, actorInput?: string): { deployment: PromptDeployment | null; live: LivePrompt } {
    const req = parse(DeployInput, input);
    const actor = normalizeActor(actorInput);
    let deploymentId: number | null = null;
    this.#db.transaction(() => {
      const live = this.#liveRow();
      this.#checkRevision(live, req.expectedRevision);
      const row = this.#isActive(name) ? this.#versionRow(name, req.version) : undefined;
      if (!row) throw notFound(`prompt '${name}' v${req.version} not found`);
      if (live.name === name && live.version === req.version) return; // 이미 배포된 버전
      const action = live.name === name && live.version !== null && req.version < live.version ? "rollback" : "deploy";
      deploymentId = this.#setLive(live, { name, version: req.version, sha: row.sha }, action, actor, req.note);
    })();
    return { deployment: deploymentId === null ? null : this.#deployment(deploymentId), live: this.live() };
  }

  reset(input: unknown, actorInput?: string): { deployment: PromptDeployment | null; live: LivePrompt } {
    const req = parse(ResetInput, input ?? {});
    const actor = normalizeActor(actorInput);
    let deploymentId: number | null = null;
    this.#db.transaction(() => {
      const live = this.#liveRow();
      this.#checkRevision(live, req.expectedRevision);
      if (live.name === null) return; // 이미 기본 프롬프트
      deploymentId = this.#setLive(live, { name: null, version: null, sha: null }, "reset", actor, req.note);
    })();
    return { deployment: deploymentId === null ? null : this.#deployment(deploymentId), live: this.live() };
  }

  // ── 내부 ───────────────────────────────────────────────────────

  #liveRow(): LiveRow {
    const row = this.#db.prepare("SELECT name, version, revision, deployed_at, deployed_by FROM prompt_live WHERE id = 1").get() as
      | LiveRow
      | undefined;
    if (!row) throw new Error("prompt_live row is missing");
    return row;
  }

  #isActive(name: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM prompts WHERE name = ? AND deleted_at IS NULL").get(name));
  }

  #versionRow(name: string, version: number): VersionRow | undefined {
    return this.#db
      .prepare("SELECT version, content, message, author, created_at, sha FROM prompt_versions WHERE name = ? AND version = ?")
      .get(name, version) as VersionRow | undefined;
  }

  #insertVersion(name: string, version: number, content: string, message: string, author: string, at: string): PromptVersion {
    const sha = versionSha(name, version, content, author, at, message);
    this.#db
      .prepare(
        "INSERT INTO prompt_versions (name, version, content, message, author, created_at, sha) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(name, version, content, message, author, at, sha);
    return { version, content, message, author, createdAt: at, sha };
  }

  #checkRevision(live: LiveRow, expected: string | undefined): void {
    if (expected !== undefined && expected !== live.revision) {
      throw conflict("live_changed", "the live prompt was changed by someone else; reload and try again", {
        revision: live.revision,
      });
    }
  }

  #setLive(
    previous: LiveRow,
    next: { name: string | null; version: number | null; sha: string | null },
    action: PromptDeployment["action"],
    actor: string,
    note: string,
  ): number {
    const at = now();
    const revision = newRevision();
    this.#db
      .prepare("UPDATE prompt_live SET name = ?, version = ?, revision = ?, deployed_at = ?, deployed_by = ? WHERE id = 1")
      .run(next.name, next.version, revision, at, actor);
    const result = this.#db
      .prepare(
        `INSERT INTO prompt_deployments (at, action, name, version, sha, actor, note, from_name, from_version, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(at, action, next.name, next.version, next.sha, actor, note, previous.name, previous.version, revision);
    return Number(result.lastInsertRowid);
  }

  #deployment(id: number): PromptDeployment | null {
    return this.deployments(500).find((d) => d.id === id) ?? null;
  }
}

function toVersion(row: VersionRow): PromptVersion {
  return {
    version: row.version,
    content: row.content,
    message: row.message,
    author: row.author,
    createdAt: row.created_at,
    sha: row.sha,
  };
}
