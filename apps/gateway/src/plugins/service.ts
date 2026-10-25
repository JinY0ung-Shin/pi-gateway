import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createSyntheticSourceInfo, type PromptTemplate, type Skill } from "@earendil-works/pi-coding-agent";
import { findTemplateRefs, MCP_SERVER_ID_PATTERN, McpScope, SANDBOX_HOME } from "@pi-gateway/shared";
import { z } from "zod";
import { badRequest, conflict, notFound, PlatformError } from "../admin/errors.js";
import type { PlatformLogger } from "../admin/logger.js";
import type { GatewayConfig } from "../config.js";
import type { PluginResources, SubagentDefinition } from "../contracts.js";
import type { Db } from "../db.js";
import { policyProblems, type McpRegistryService } from "../mcp-registry/service.js";
import { normalizeActor } from "../prompts/service.js";
import { discoverComponents, rewriteTextFiles } from "./components.js";
import { gitFetch, normalizeGitUrl } from "./git.js";
import { type JsonObject, readPluginManifest, safeVersion, str } from "./manifest.js";
import {
  describeSource,
  type MarketplaceEntry,
  type MarketplaceManifest,
  readMarketplaceManifest,
  resolveInside,
  resolveRelativeSource,
} from "./marketplace.js";
import {
  DEFAULT_PLUGIN_MCP_DEFAULTS,
  type MappedMcpServer,
  mapPluginMcpServer,
  pluginEntryFiles,
  type PluginMcpDefaults,
  referencedDefaultEnv,
  sanitizeServerId,
} from "./mcp-mapping.js";
import { type CopyLimits, DEFAULT_COPY_LIMITS, readContainedFile, safeCopyTree } from "./safe-copy.js";
import { type McpRecord, type MarketplaceRecord, type PluginRecord, PluginStore, type ResolvedSource } from "./store.js";

const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const AddMarketplaceInput = z.object({
  url: z.string().min(1).max(2048),
  ref: z.string().max(200).optional(),
  token: z.string().max(4096).optional(),
  tokenUsername: z.string().max(100).optional(),
});

const RefreshMarketplaceInput = z.object({
  token: z.string().max(4096).optional(),
  tokenUsername: z.string().max(100).optional(),
});

const McpOverrideInput = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN).optional(),
  env: z.record(envKey, z.string().max(4096)).optional(),
  scope: McpScope.optional(),
  enabled: z.boolean().optional(),
});

const InstallInput = z.object({
  marketplace: z.string().min(1),
  plugin: z.string().min(1),
  token: z.string().max(4096).optional(),
  tokenUsername: z.string().max(100).optional(),
  /** plugin 안의 MCP 서버 이름 → 덮어쓸 값 */
  mcpOverrides: z.record(z.string(), McpOverrideInput).default({}),
});

const SettingsInput = z.object({
  mcpDefaults: z.object({
    env: z.record(envKey, z.string().max(4096)),
    scope: McpScope,
  }),
});

export interface PluginSettings {
  mcpDefaults: PluginMcpDefaults;
}

export interface MarketplaceView {
  name: string;
  url: string;
  ref: string | null;
  commitSha: string;
  description?: string;
  owner?: string;
  pluginCount: number;
  invalidEntries: number;
  addedAt: string;
  refreshedAt: string;
  addedBy: string;
}

export interface CatalogEntry {
  name: string;
  description?: string;
  /** marketplace.json 항목에 적힌 버전 (설치본의 plugin.json 버전과 다를 수 있다) */
  listedVersion?: string;
  category?: string;
  tags: string[];
  source: string;
  sourceType: string;
  supported: boolean;
  installed: { id: string; version: string; enabled: boolean } | null;
}

export interface PluginView {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  installPath: string;
  description?: string;
  source: ResolvedSource;
  installedAt: string;
  updatedAt: string;
  installedBy: string;
  components: PluginRecord["components"];
  mcp: McpRecord[];
}

export interface PluginServiceOptions {
  registry: McpRegistryService;
  log: PlatformLogger;
  /** 로컬 경로·file:// 저장소 허용 (테스트·개발용). 기본값은 PLUGIN_ALLOW_LOCAL_SOURCES=1일 때만. */
  allowLocalSources?: boolean;
  gitTimeoutMs?: number;
  copyLimits?: CopyLimits;
}

interface ResourceCache {
  revision: number;
  skills: Skill[];
  templates: PromptTemplate[];
  agents: SubagentDefinition[];
}

const SETTINGS_KEY = "plugins.mcp_defaults";

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw badRequest(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), result.error.issues);
  }
  return result.data;
}

const randomId = () => randomBytes(6).toString("hex");

/** sandbox 안에서 plugin이 쓰는 데이터 디렉토리 (사용자별 workspace 안) */
export function pluginDataDir(marketplace: string, plugin: string): string {
  return `${SANDBOX_HOME}/.plugin-data/${marketplace}--${plugin}`;
}

/**
 * Claude Code marketplace plugin 설치·관리. PluginResources(세션용)를 구현한다.
 * plugin 코드는 gateway에서 실행하지 않는다 (git과 파일 복사만 한다).
 *
 * 디렉토리
 * - `${dataDir}/plugin-marketplaces/<name>`: marketplace 저장소 사본 (gateway 전용, sandbox에 보이지 않음)
 * - `${dataDir}/plugin-work/`: git 작업용 임시 디렉토리
 * - `${pluginsDir}/<marketplace>/<plugin>/<version>`: 설치본 (sandbox에 읽기 전용으로 보인다). 현재와 바로 이전 버전만 남긴다.
 * - `${pluginsDir}/<marketplace>/<plugin>/current` → `<version>`: 상대 symlink. 기록·skill 경로·MCP args·`${CLAUDE_PLUGIN_ROOT}`는
 *   이 고정 경로를 쓴다. 업데이트해도 세션에 남은 skill 경로를 그대로 쓸 수 있다.
 */
export class PluginService implements PluginResources {
  readonly store: PluginStore;
  readonly #registry: McpRegistryService;
  readonly #log: PlatformLogger;
  readonly #pluginsDir: string;
  readonly #workDir: string;
  readonly #marketplacesDir: string;
  readonly #allowLocal: boolean;
  readonly #gitTimeoutMs: number;
  readonly #limits: CopyLimits;
  #cache: ResourceCache | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: Db, config: Pick<GatewayConfig, "pluginsDir" | "dataDir">, options: PluginServiceOptions) {
    this.store = new PluginStore(db);
    this.#registry = options.registry;
    this.#log = options.log;
    this.#pluginsDir = config.pluginsDir;
    this.#workDir = join(config.dataDir, "plugin-work");
    this.#marketplacesDir = join(config.dataDir, "plugin-marketplaces");
    this.#allowLocal = options.allowLocalSources ?? process.env.PLUGIN_ALLOW_LOCAL_SOURCES === "1";
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 120_000;
    this.#limits = options.copyLimits ?? DEFAULT_COPY_LIMITS;
  }

  // ── PluginResources ────────────────────────────────────────────

  revision(): number {
    return this.store.revision();
  }

  skills(): Skill[] {
    return [...this.#resources().skills];
  }

  promptTemplates(): PromptTemplate[] {
    return [...this.#resources().templates];
  }

  agents(): SubagentDefinition[] {
    return [...this.#resources().agents];
  }

  #resources(): ResourceCache {
    const revision = this.store.revision();
    if (this.#cache?.revision === revision) return this.#cache;
    const skills: Skill[] = [];
    const templates: PromptTemplate[] = [];
    const agents: SubagentDefinition[] = [];
    for (const plugin of this.store.listPlugins()) {
      if (!plugin.enabled) continue;
      const source = `plugin:${plugin.id}`;
      for (const s of plugin.components.skills) {
        skills.push({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          baseDir: s.baseDir,
          disableModelInvocation: s.disableModelInvocation,
          sourceInfo: createSyntheticSourceInfo(s.filePath, { source, scope: "user", origin: "package", baseDir: plugin.installPath }),
        });
      }
      for (const c of plugin.components.commands) {
        templates.push({
          name: c.name,
          description: c.description,
          ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
          content: c.content,
          filePath: c.filePath,
          sourceInfo: createSyntheticSourceInfo(c.filePath, { source, scope: "user", origin: "package", baseDir: plugin.installPath }),
        });
      }
      for (const a of plugin.components.agents) {
        agents.push({ name: a.name, description: a.description, ...(a.tools ? { tools: a.tools } : {}), prompt: a.prompt });
      }
    }
    this.#cache = { revision, skills, templates, agents };
    return this.#cache;
  }

  // ── 설정 ───────────────────────────────────────────────────────

  getSettings(): PluginSettings {
    return { mcpDefaults: this.store.getSetting(SETTINGS_KEY, DEFAULT_PLUGIN_MCP_DEFAULTS) };
  }

  updateSettings(input: unknown, actorInput?: string): PluginSettings {
    const req = parse(SettingsInput, input);
    for (const [key, value] of Object.entries(req.mcpDefaults.env)) {
      const { refs, unknown } = findTemplateRefs(value);
      if (unknown.length > 0) throw badRequest(`env ${key}: unknown placeholder ${unknown.join(", ")}`);
      if (refs.some((r) => r.kind === "secret" || r.kind === "header")) {
        throw badRequest(`env ${key}: sandbox servers must not use {{secret:...}} or {{ctx.header:...}}`);
      }
    }
    this.store.setSetting(SETTINGS_KEY, req.mcpDefaults, normalizeActor(actorInput));
    return this.getSettings();
  }

  // ── marketplace ────────────────────────────────────────────────

  listMarketplaces(): MarketplaceView[] {
    return this.store.listMarketplaces().map(toMarketplaceView);
  }

  getMarketplace(name: string): MarketplaceView & { plugins: CatalogEntry[]; invalid: MarketplaceManifest["invalid"] } {
    const record = this.store.getMarketplace(name);
    if (!record) throw notFound(`marketplace '${name}' not found`);
    const installed = new Map(this.store.listPlugins().filter((p) => p.marketplace === name).map((p) => [p.name, p]));
    return {
      ...toMarketplaceView(record),
      invalid: record.manifest.invalid,
      plugins: record.manifest.plugins.map((entry) => {
        const plugin = installed.get(entry.name);
        return {
          name: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.version ? { listedVersion: entry.version } : {}),
          ...(entry.category ? { category: entry.category } : {}),
          tags: entry.tags,
          source: describeSource(entry.source),
          sourceType: entry.source.type === "unsupported" ? entry.source.kind : entry.source.type,
          supported: entry.source.type !== "unsupported",
          installed: plugin ? { id: plugin.id, version: plugin.version, enabled: plugin.enabled } : null,
        };
      }),
    };
  }

  addMarketplace(input: unknown, actorInput?: string): Promise<MarketplaceView> {
    const req = parse(AddMarketplaceInput, input);
    const actor = normalizeActor(actorInput);
    return this.#exclusive(async () => {
      const url = normalizeGitUrl(req.url, this.#allowLocal);
      const { dir, commit, manifest, work } = await this.#cloneMarketplace(url, req.ref, req);
      try {
        if (this.store.getMarketplace(manifest.name)) {
          throw conflict("exists", `marketplace '${manifest.name}' already exists; refresh it instead`);
        }
        const localPath = await this.#placeMarketplace(dir, manifest.name);
        this.store.upsertMarketplace({
          name: manifest.name,
          url,
          ref: req.ref ?? null,
          commitSha: commit,
          localPath,
          manifest,
          addedBy: actor,
        });
        this.#log.info({ marketplace: manifest.name, commit, actor }, "marketplace added");
        return toMarketplaceView(this.store.getMarketplace(manifest.name)!);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }

  refreshMarketplace(name: string, input: unknown, actorInput?: string): Promise<MarketplaceView> {
    const req = parse(RefreshMarketplaceInput, input);
    const actor = normalizeActor(actorInput);
    return this.#exclusive(async () => {
      const record = this.store.getMarketplace(name);
      if (!record) throw notFound(`marketplace '${name}' not found`);
      const { dir, commit, manifest, work } = await this.#cloneMarketplace(record.url, record.ref ?? undefined, req);
      try {
        if (manifest.name !== name) {
          throw conflict("name_changed", `the repository now declares marketplace '${manifest.name}' instead of '${name}'`);
        }
        const localPath = await this.#placeMarketplace(dir, name);
        this.store.upsertMarketplace({ ...record, commitSha: commit, localPath, manifest, addedBy: record.addedBy });
        this.#log.info({ marketplace: name, commit, actor }, "marketplace refreshed");
        return toMarketplaceView(this.store.getMarketplace(name)!);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    });
  }

  removeMarketplace(name: string, actorInput?: string): Promise<void> {
    const actor = normalizeActor(actorInput);
    return this.#exclusive(async () => {
      const record = this.store.getMarketplace(name);
      if (!record) throw notFound(`marketplace '${name}' not found`);
      const plugins = this.store.listPlugins().filter((p) => p.marketplace === name);
      if (plugins.length > 0) {
        throw conflict("has_plugins", `uninstall the plugins from '${name}' first: ${plugins.map((p) => p.name).join(", ")}`);
      }
      this.store.deleteMarketplace(name);
      await rm(record.localPath, { recursive: true, force: true });
      this.#log.info({ marketplace: name, actor }, "marketplace removed");
    });
  }

  // ── plugin ─────────────────────────────────────────────────────

  listPlugins(): PluginView[] {
    return this.store.listPlugins().map(toPluginView);
  }

  getPlugin(id: string): PluginView {
    const record = this.store.getPlugin(id);
    if (!record) throw notFound(`plugin '${id}' not found`);
    return toPluginView(record);
  }

  /** 설치된 skill의 SKILL.md 본문 (관리 화면 조회용) */
  async skillContent(id: string, name: string): Promise<{ content: string }> {
    const record = this.store.getPlugin(id);
    const skill = record?.components.skills.find((s) => s.name === name);
    if (!record || !skill) throw notFound(`skill '${name}' not found in plugin '${id}'`);
    return { content: (await readContainedFile(record.installPath, relative(record.installPath, skill.filePath))) ?? "" };
  }

  install(input: unknown, actorInput?: string): Promise<{ plugin: PluginView; warnings: string[] }> {
    const req = parse(InstallInput, input);
    const actor = normalizeActor(actorInput);
    return this.#exclusive(() => this.#install(req, actor));
  }

  /** marketplace의 현재 내용으로 다시 설치한다 (먼저 marketplace를 새로고침해야 새 버전이 보인다). */
  update(id: string, input: unknown, actorInput?: string): Promise<{ plugin: PluginView; warnings: string[] }> {
    const record = this.store.getPlugin(id);
    if (!record) throw notFound(`plugin '${id}' not found`);
    const extra = (input ?? {}) as Record<string, unknown>;
    return this.install({ ...extra, marketplace: record.marketplace, plugin: record.name }, actorInput);
  }

  setEnabled(id: string, enabled: boolean, actorInput?: string): Promise<{ plugin: PluginView; warnings: string[] }> {
    const actor = normalizeActor(actorInput);
    return this.#exclusive(async () => {
      const record = this.store.getPlugin(id);
      if (!record) throw notFound(`plugin '${id}' not found`);
      // MCP 서버 상태를 먼저 바꾼다. broker 서버가 있는 plugin은 broker가 안 되면 503으로 끝나고 상태도 그대로 둔다.
      await this.#registry.setPluginServersEnabled(id, enabled, actor, { broker: usesBroker(record) });
      this.store.setEnabled(id, enabled);
      this.store.bumpRevision();
      this.#log.info({ plugin: id, enabled, actor }, "plugin enabled state changed");
      return { plugin: this.getPlugin(id), warnings: [] };
    });
  }

  uninstall(id: string, actorInput?: string): Promise<{ removedMcpServers: string[] }> {
    const actor = normalizeActor(actorInput);
    return this.#exclusive(async () => {
      const record = this.store.getPlugin(id);
      if (!record) throw notFound(`plugin '${id}' not found`);
      // broker 쪽을 지우지 못하면 503으로 끝난다 (서버와 비밀키가 남은 채 plugin만 사라지지 않게 한다).
      // broker 서버가 없는 plugin은 broker에 묻지 않는다.
      const removedMcpServers = await this.#registry.removePluginServers(id, actor, { broker: usesBroker(record) });
      this.store.deletePlugin(id);
      this.store.bumpRevision();
      await rm(join(this.#pluginsDir, record.marketplace, record.name), { recursive: true, force: true });
      this.#log.info({ plugin: id, actor }, "plugin uninstalled");
      return { removedMcpServers };
    });
  }

  // ── 내부 ───────────────────────────────────────────────────────

  async #install(req: z.infer<typeof InstallInput>, actor: string): Promise<{ plugin: PluginView; warnings: string[] }> {
    const marketplace = this.store.getMarketplace(req.marketplace);
    if (!marketplace) throw notFound(`marketplace '${req.marketplace}' not found`);
    const entry = marketplace.manifest.plugins.find((p) => p.name === req.plugin);
    if (!entry) throw notFound(`plugin '${req.plugin}' is not in marketplace '${req.marketplace}'`);
    const id = `${entry.name}@${marketplace.name}`;
    const clash = this.store.listPlugins().find((p) => p.name === entry.name && p.id !== id);
    if (clash) throw conflict("name_conflict", `a plugin named '${entry.name}' is already installed from '${clash.marketplace}'`);
    const previous = this.store.getPlugin(id);

    await mkdir(this.#workDir, { recursive: true });
    const work = await mkdtemp(join(this.#workDir, "install-"));
    const staging = join(this.#pluginsDir, ".staging", randomId());
    const warnings: string[] = [];
    try {
      const { dir: sourceDir, resolved } = await this.#fetchSource(entry, marketplace, req, work);
      const manifest = await readPluginManifest(sourceDir);
      const version = safeVersion(
        str(manifest ?? {}, "version") ?? entry.version ?? resolved.commit?.slice(0, 12) ?? "unknown",
      );
      const pluginDir = join(this.#pluginsDir, marketplace.name, entry.name);
      const versionDir = join(pluginDir, version);
      // 기록·치환·MCP 인자에는 버전 없는 고정 경로를 쓴다. 업데이트해도 세션에 남은 skill 경로를 그대로 쓸 수 있다.
      const finalDir = stablePluginPath(pluginDir);
      const dataDir = pluginDataDir(marketplace.name, entry.name);

      const copy = await safeCopyTree(sourceDir, staging, this.#limits);
      const found = await discoverComponents({ stagingDir: staging, finalDir, pluginName: entry.name, manifest, entry, dataDir });
      await rewriteTextFiles(found, staging, finalDir, dataDir);

      const enabled = previous?.enabled ?? true;
      const description = str(manifest ?? {}, "description") ?? entry.description;
      // MCP 매핑을 먼저 한다. broker가 필요한데 연결되지 않으면 아무것도 바꾸기 전에 503으로 끝낸다.
      const mappedServers = await this.#mapServers(found.mcpServers, {
        id,
        pluginName: entry.name,
        version,
        root: finalDir,
        dataDir,
        description,
        overrides: req.mcpOverrides,
        enabled,
        read: (rel) => readContainedFile(staging, rel, { optional: true }).catch(() => undefined),
      });
      const needsBroker =
        mappedServers.some((m) => m.mapped.config?.runIn === "broker") || (previous ? usesBroker(previous) : false);
      if (needsBroker) await this.#registry.assertBrokerReachable();
      await this.#swapInto(staging, pluginDir, versionDir);
      await pointCurrentAt(pluginDir, version);
      const record: Omit<PluginRecord, "installedAt" | "updatedAt"> = {
        id,
        marketplace: marketplace.name,
        name: entry.name,
        version,
        installPath: finalDir,
        enabled,
        source: resolved,
        manifest: manifest ?? null,
        components: {
          skills: found.skills,
          commands: found.commands,
          agents: found.agents,
          unsupported: found.unsupported,
          warnings: found.warnings,
          copySkipped: copy.skipped,
        },
        mcp: previous?.mcp ?? [],
        installedBy: actor,
      };
      if (description && !record.manifest) record.manifest = { description };
      this.store.upsertPlugin(record);

      const { records: mcp, warnings: mcpWarnings } = await this.#registerMcp(mappedServers, {
        id,
        pluginName: entry.name,
        previous: previous?.mcp ?? [],
        actor,
      });
      this.store.setPluginMcp(id, mcp);
      this.store.bumpRevision();
      await this.#pruneVersions(pluginDir, [version, previous?.version]);

      warnings.push(...found.warnings);
      for (const s of copy.skipped) warnings.push(`건너뛴 파일 ${s.path}: ${s.reason}`);
      for (const m of mcp) {
        if (m.status !== "registered") warnings.push(`MCP 서버 ${m.name}: ${m.reason ?? m.status}`);
        else if ((m.missingSecrets ?? m.requiredSecrets).length > 0) {
          warnings.push(
            `MCP 서버 ${m.id}: 비밀키 ${(m.missingSecrets ?? m.requiredSecrets).join(", ")}를 관리 화면에서 입력해야 합니다` +
              (previous ? " (접속 대상이 바뀌면 broker가 저장된 비밀키를 지웁니다)" : ""),
          );
        }
      }
      warnings.push(...mcpWarnings);
      this.#log.info({ plugin: id, version, actor, skills: found.skills.length, commands: found.commands.length, mcp: mcp.length }, "plugin installed");
      return { plugin: this.getPlugin(id), warnings };
    } finally {
      await rm(work, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #fetchSource(
    entry: MarketplaceEntry,
    marketplace: MarketplaceRecord,
    auth: { token?: string | undefined; tokenUsername?: string | undefined },
    work: string,
  ): Promise<{ dir: string; resolved: ResolvedSource }> {
    const source = entry.source;
    const display = describeSource(source);
    if (source.type === "relative") {
      const dir = await resolveRelativeSource(marketplace.localPath, source.path, marketplace.manifest.pluginRoot);
      return { dir, resolved: { type: "relative", display, path: source.path, commit: marketplace.commitSha } };
    }
    if (source.type === "unsupported") {
      throw new PlatformError(400, "unsupported_source", `plugin source type '${source.kind}' is not supported (relative, github, url, git-subdir only)`);
    }
    const url = source.type === "github" ? `https://github.com/${source.repo}.git` : source.url;
    const dest = join(work, "src");
    const { commit } = await gitFetch({
      url,
      ref: source.ref,
      sha: source.sha,
      dest,
      tmpRoot: work,
      allowLocal: this.#allowLocal,
      timeoutMs: this.#gitTimeoutMs,
      token: auth.token,
      username: auth.tokenUsername,
    });
    const pins = { ...(source.ref ? { ref: source.ref } : {}), ...(source.sha ? { sha: source.sha } : {}) };
    if (source.type === "git-subdir") {
      const dir = await resolveInside(dest, source.path.replace(/^\.\//, ""), "git-subdir path");
      return { dir, resolved: { type: "git-subdir", display, url, path: source.path, commit, ...pins } };
    }
    return { dir: dest, resolved: { type: source.type, display, url, commit, ...pins } };
  }

  /** plugin의 MCP 서버 설정을 gateway 설정으로 바꾼다 (아직 등록하지 않는다). */
  async #mapServers(
    servers: Record<string, unknown>,
    ctx: {
      id: string;
      pluginName: string;
      version: string;
      root: string;
      dataDir: string;
      description: string | undefined;
      overrides: z.infer<typeof InstallInput>["mcpOverrides"];
      enabled: boolean;
      /** plugin 기준 상대 경로의 파일 내용 (참조 검사용) */
      read: (rel: string) => Promise<string | undefined>;
    },
  ): Promise<{ name: string; mapped: MappedMcpServer }[]> {
    const defaults = this.getSettings().mcpDefaults;
    const out: { name: string; mapped: MappedMcpServer }[] = [];
    for (const [name, raw] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      const texts = (await Promise.all(pluginEntryFiles(raw).map((rel) => ctx.read(rel)))).filter((t): t is string => t !== undefined);
      const override = ctx.overrides[name];
      const mapped = mapPluginMcpServer(name, raw, {
        pluginId: ctx.id,
        pluginName: ctx.pluginName,
        version: ctx.version,
        root: ctx.root,
        dataDir: ctx.dataDir,
        description: ctx.description,
        defaults: { env: referencedDefaultEnv(raw, defaults.env, texts), scope: defaults.scope },
        override: override ? { ...override, enabled: ctx.enabled ? override.enabled : false } : { enabled: ctx.enabled ? undefined : false },
      });
      out.push({ name, mapped });
    }
    return out;
  }

  async #registerMcp(
    mappedServers: { name: string; mapped: MappedMcpServer }[],
    ctx: { id: string; pluginName: string; previous: McpRecord[]; actor: string },
  ): Promise<{ records: McpRecord[]; warnings: string[] }> {
    const records: McpRecord[] = [];
    const warnings: string[] = [];
    const used = new Set<string>();
    for (const { name, mapped } of mappedServers) {
      if (!mapped.config) {
        records.push({ name, status: "unsupported", reason: mapped.unsupported ?? "unsupported", requiredSecrets: [], warnings: mapped.warnings });
        continue;
      }
      const previous = ctx.previous.find((r) => r.name === name);
      let config = mapped.config;
      // 지난번에 다른 id(충돌로 이름을 바꾼 id)를 썼으면 그 id를 이어서 쓴다.
      if (previous?.id && previous.id !== config.id && previous.status === "registered") config = { ...config, id: previous.id };
      // 다른 서버가 쓰는 id면 plugin 이름을 붙여 본다.
      if (used.has(config.id) || (await this.#idTakenByOther(config.id, ctx.id, config.runIn))) {
        const alt = sanitizeServerId(`${ctx.pluginName}-${name}`);
        if (!alt || used.has(alt) || (await this.#idTakenByOther(alt, ctx.id, config.runIn))) {
          records.push({ name, status: "error", reason: `MCP server id '${config.id}' is already in use`, requiredSecrets: mapped.requiredSecrets, warnings: mapped.warnings });
          continue;
        }
        config = { ...config, id: alt };
      }
      used.add(config.id);
      if (config.runIn === "broker" && !this.#registry.brokerConfigured) {
        records.push({
          name,
          id: config.id,
          runIn: "broker",
          status: "broker_unavailable",
          reason: "this server needs the MCP broker (BROKER_URL is not configured)",
          requiredSecrets: mapped.requiredSecrets,
          warnings: mapped.warnings,
        });
        continue;
      }
      const problems = policyProblems(config);
      if (problems.length > 0) {
        records.push({ name, id: config.id, runIn: config.runIn, status: "error", reason: problems.join("; "), requiredSecrets: mapped.requiredSecrets, warnings: mapped.warnings });
        continue;
      }
      const baseline = previous?.id === config.id ? (previous.baseline ?? null) : null;
      try {
        const entry = await this.#registry.upsertPluginServer(config, ctx.actor, baseline);
        records.push({
          name,
          id: config.id,
          runIn: config.runIn,
          status: "registered",
          requiredSecrets: mapped.requiredSecrets,
          ...(entry.missingSecrets ? { missingSecrets: entry.missingSecrets } : {}),
          warnings: mapped.warnings,
          baseline: config,
        });
      } catch (error) {
        records.push({
          name,
          id: config.id,
          runIn: config.runIn,
          status: error instanceof PlatformError && error.code === "broker_unavailable" ? "broker_unavailable" : "error",
          reason: describe(error),
          requiredSecrets: mapped.requiredSecrets,
          warnings: mapped.warnings,
        });
      }
    }
    // 새 버전에서 사라진 서버는 지운다. 지우지 못하면 경고로 알린다 (조용히 넘어가지 않는다).
    for (const old of ctx.previous) {
      if (old.id && old.status === "registered" && !used.has(old.id)) {
        await this.#registry.remove(old.id, ctx.actor).catch((error: unknown) => {
          warnings.push(`이전 버전의 MCP 서버 ${old.id}를 지우지 못했습니다: ${describe(error)}`);
        });
      }
    }
    return { records, warnings };
  }

  async #idTakenByOther(id: string, pluginId: string, runIn: "broker" | "sandbox"): Promise<boolean> {
    const current = await this.#registry.currentConfig(id, { tolerateDown: runIn === "sandbox" });
    if (!current) return false;
    return !(current.source.kind === "plugin" && current.source.pluginId === pluginId);
  }

  async #cloneMarketplace(
    url: string,
    ref: string | undefined,
    auth: { token?: string | undefined; tokenUsername?: string | undefined },
  ): Promise<{ dir: string; commit: string; manifest: MarketplaceManifest; work: string }> {
    await mkdir(this.#workDir, { recursive: true });
    const work = await mkdtemp(join(this.#workDir, "marketplace-"));
    try {
      const dir = join(work, "repo");
      const { commit } = await gitFetch({
        url,
        ref,
        dest: dir,
        tmpRoot: work,
        allowLocal: this.#allowLocal,
        timeoutMs: this.#gitTimeoutMs,
        token: auth.token,
        username: auth.tokenUsername,
      });
      const manifest = await readMarketplaceManifest(dir);
      return { dir, commit, manifest, work };
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      throw error;
    }
  }

  /** 받은 저장소를 marketplace 위치로 옮긴다. `.git`은 지운다 (원격 주소 외에는 필요 없다). */
  async #placeMarketplace(dir: string, name: string): Promise<string> {
    await rm(join(dir, ".git"), { recursive: true, force: true });
    await mkdir(this.#marketplacesDir, { recursive: true });
    const target = join(this.#marketplacesDir, name);
    const trash = join(this.#marketplacesDir, `.old-${name}-${randomId()}`);
    if (existsSync(target)) await rename(target, trash);
    await rename(dir, target);
    await rm(trash, { recursive: true, force: true });
    return target;
  }

  async #swapInto(staging: string, pluginDir: string, finalDir: string): Promise<void> {
    await mkdir(pluginDir, { recursive: true, mode: 0o755 });
    // umask와 관계없이 sandbox가 읽을 수 있게 한다.
    for (const dir of [this.#pluginsDir, dirname(pluginDir), pluginDir]) await chmod(dir, 0o755).catch(() => {});
    if (existsSync(finalDir)) {
      const trash = join(this.#pluginsDir, ".trash", randomId());
      await mkdir(dirname(trash), { recursive: true });
      await rename(finalDir, trash);
      await rename(staging, finalDir);
      await rm(trash, { recursive: true, force: true });
    } else {
      await rename(staging, finalDir);
    }
  }

  /** 현재 버전과 바로 이전 버전만 남긴다 (이전 버전을 쓰던 세션이 끝날 때까지 필요하다). */
  async #pruneVersions(pluginDir: string, keep: (string | undefined)[]): Promise<void> {
    const keepSet = new Set(keep.filter((v): v is string => Boolean(v)));
    let names: string[];
    try {
      names = await readdir(pluginDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === CURRENT_LINK || name.startsWith(".")) continue;
      if (!keepSet.has(name)) await rm(join(pluginDir, name), { recursive: true, force: true });
    }
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** 설치본의 고정 경로 이름. `<plugin>/current` → 현재 버전 디렉토리를 가리키는 상대 심볼릭 링크다. */
const CURRENT_LINK = "current";

function stablePluginPath(pluginDir: string): string {
  return join(pluginDir, CURRENT_LINK);
}

/** `<plugin>/current`를 version으로 바꾼다. 임시 링크를 만든 뒤 rename으로 한 번에 바꾼다 (중간 상태가 없다). */
async function pointCurrentAt(pluginDir: string, version: string): Promise<void> {
  const tmp = join(pluginDir, `.current-${randomId()}`);
  await symlink(version, tmp);
  await rename(tmp, stablePluginPath(pluginDir)).catch(async (error: unknown) => {
    await rm(tmp, { force: true });
    throw error;
  });
}

/** plugin 기록상 broker에 서버가 있을 수 있는지 (등록하다 실패한 것도 broker에 남았을 수 있다) */
function usesBroker(record: Pick<PluginRecord, "mcp">): boolean {
  return record.mcp.some((m) => m.runIn === "broker" && (m.status === "registered" || m.status === "error" || m.status === "broker_unavailable"));
}

function toMarketplaceView(record: MarketplaceRecord): MarketplaceView {
  return {
    name: record.name,
    url: record.url,
    ref: record.ref,
    commitSha: record.commitSha,
    ...(record.manifest.description ? { description: record.manifest.description } : {}),
    ...(record.manifest.owner ? { owner: record.manifest.owner } : {}),
    pluginCount: record.manifest.plugins.length,
    invalidEntries: record.manifest.invalid.length,
    addedAt: record.addedAt,
    refreshedAt: record.refreshedAt,
    addedBy: record.addedBy,
  };
}

function toPluginView(record: PluginRecord): PluginView {
  const manifest: JsonObject = record.manifest ?? {};
  const description = str(manifest, "description");
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    version: record.version,
    enabled: record.enabled,
    installPath: record.installPath,
    ...(description ? { description } : {}),
    source: record.source,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
    installedBy: record.installedBy,
    components: record.components,
    // baseline은 내부 병합용이라 응답에 넣지 않는다.
    mcp: record.mcp.map(({ baseline: _baseline, ...rest }) => rest),
  };
}

function describe(error: unknown): string {
  if (error instanceof PlatformError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
