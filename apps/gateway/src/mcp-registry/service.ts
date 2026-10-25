import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  type AuditEvent,
  collectTemplateRefs,
  findLiteralCredentials,
  McpServerConfig,
  type McpScope,
  PutSecretRequest,
  requiredSecretNames,
  SecretName,
  type McpServerStatus,
  type McpServerView,
  type SecretInfo,
  type TestServerResponse,
  type ToolSummary,
  type VisibleServer,
} from "@pi-gateway/shared";
import type { z } from "zod";
import { badRequest, notFound, PlatformError } from "../admin/errors.js";
import type { PlatformLogger } from "../admin/logger.js";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { Db } from "../db.js";
import { BrokerClient, BrokerError, type FetchLike } from "./broker-client.js";
import { SandboxServerStore } from "./store.js";

export type McpStore = "sandbox" | "broker";

/** 관리 화면에 보여주는 서버 한 개. 비밀값은 들어 있지 않다. */
export interface McpServerEntry {
  store: McpStore;
  config: McpServerConfig;
  /** 설정이 참조하는 비밀키 이름 */
  requiredSecrets: string[];
  /** broker 서버만: 설정된 비밀키 (이름, 시각, fingerprint) */
  secrets?: SecretInfo[];
  missingSecrets?: string[];
  status?: z.infer<typeof McpServerStatus>;
}

export interface McpServerList {
  servers: McpServerEntry[];
  broker: { available: boolean; error?: string };
}

export interface McpRegistryOptions {
  fetch?: FetchLike;
}

const SANDBOX_CREDENTIAL_HINT =
  "sandbox 서버의 env는 agent에게 보이므로 자격증명을 넣을 수 없습니다. 자격증명이 필요한 서버는 HTTP로 띄워 runIn=broker로 등록하고 {{secret:NAME}}을 쓰세요";

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
}

/** 스키마 밖의 규칙. upsert와 validate가 같은 규칙을 쓴다. */
export function policyProblems(config: McpServerConfig): string[] {
  const problems = findLiteralCredentials(config).map((p) => (config.runIn === "sandbox" ? `${p} — ${SANDBOX_CREDENTIAL_HINT}` : p));
  if (config.runIn === "broker" && config.id === "servers") problems.push("id 'servers' is reserved by the broker");
  for (const value of [...(config.transport.type === "stdio" ? [config.transport.command, ...config.transport.args, ...Object.values(config.transport.env)] : [config.transport.url, ...Object.values(config.transport.headers)])]) {
    if (/\{\{\s*plugin_root\s*\}\}/.test(value)) {
      problems.push("{{plugin_root}} must be resolved to the installed plugin path");
      break;
    }
  }
  return problems;
}

function toEntry(view: McpServerView): McpServerEntry {
  return {
    store: "broker",
    config: view.config,
    requiredSecrets: requiredSecretNames(view.config),
    secrets: view.secrets,
    missingSecrets: view.missingSecrets,
    ...(view.status ? { status: view.status } : {}),
  };
}

/**
 * MCP 서버 목록. sandbox 실행 서버는 gateway DB에, broker 실행 서버는 broker에 저장된다.
 * 서버 id는 두 저장소를 합쳐서 유일해야 한다.
 * broker에 연결되지 않으면, broker를 확인해야 하는 변경은 모두 503으로 실패한다
 * (조용히 한쪽만 바뀌어 두 저장소가 어긋나는 일을 막는다).
 */
export class McpRegistryService implements McpRegistry {
  readonly store: SandboxServerStore;
  readonly #broker: BrokerClient;
  readonly #log: PlatformLogger;
  readonly #pluginsDir: string;

  constructor(db: Db, config: Pick<GatewayConfig, "broker" | "pluginsDir">, log: PlatformLogger, options: McpRegistryOptions = {}) {
    this.store = new SandboxServerStore(db, log);
    this.#broker = new BrokerClient(config.broker, options.fetch);
    this.#log = log;
    this.#pluginsDir = config.pluginsDir;
  }

  // ── 세션용 (McpRegistry) ────────────────────────────────────────

  sandboxServers(): McpServerConfig[] {
    return this.store.list().filter((c) => c.enabled);
  }

  async brokerServersFor(principal: string, sessionId: string): Promise<VisibleServer[]> {
    try {
      return await this.#broker.visibleServers(principal, sessionId);
    } catch (error) {
      this.#log.warn({ err: describe(error) }, "could not list MCP servers from the broker; continuing without them");
      return [];
    }
  }

  // ── 관리 ───────────────────────────────────────────────────────

  /** 목록 화면용. broker가 안 되면 sandbox 서버만 보여주고 broker.error에 이유를 담는다. */
  async list(): Promise<McpServerList> {
    const servers: McpServerEntry[] = this.store.list().map((config) => ({
      store: "sandbox",
      config,
      requiredSecrets: requiredSecretNames(config),
    }));
    const broker: McpServerList["broker"] = { available: false };
    try {
      const views = await this.#broker.listServers();
      this.store.replaceBrokerIds(views.map((v) => v.config.id));
      servers.push(...views.map(toEntry));
      broker.available = true;
    } catch (error) {
      broker.error = describe(error);
    }
    servers.sort((a, b) => a.config.id.localeCompare(b.config.id));
    return { servers, broker };
  }

  async get(id: string): Promise<McpServerEntry> {
    const local = this.store.get(id);
    if (local) return { store: "sandbox", config: local, requiredSecrets: requiredSecretNames(local) };
    const remote = await this.#brokerEntry(id);
    if (remote) return remote;
    throw notFound(`MCP server '${id}' not found`);
  }

  validate(input: unknown): { ok: boolean; errors: string[]; config?: McpServerConfig; requiredSecrets: string[] } {
    const result = McpServerConfig.safeParse(input);
    if (!result.success) {
      return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`), requiredSecrets: [] };
    }
    const errors = policyProblems(result.data);
    return { ok: errors.length === 0, errors, config: result.data, requiredSecrets: requiredSecretNames(result.data) };
  }

  /** 만들거나 바꾼다. runIn이 바뀌면 다른 저장소로 옮긴다. */
  async upsert(input: unknown, actor: string): Promise<McpServerEntry> {
    const parsed = McpServerConfig.safeParse(input);
    if (!parsed.success) throw badRequest(issuesMessage(parsed.error), parsed.error.issues);
    const config = parsed.data;
    const problems = policyProblems(config);
    if (problems.length > 0) throw badRequest(problems.join("; "), problems);
    if (config.runIn === "sandbox") {
      // broker에 같은 id가 있으면 옮기는 것이므로 broker 쪽을 지워야 한다. 이미 sandbox 서버이고 broker id로
      // 본 적이 없으면 묻지 않는다 (id는 한 저장소에만 둔다). broker가 안 될 때는
      // 마지막으로 본 broker id 목록에 없을 때만 진행한다 (있으면 503: 두 저장소에 같은 id가 생긴다).
      const askBroker = !this.store.get(config.id) || this.store.knownBrokerId(config.id);
      const remote = askBroker ? await this.#brokerEntry(config.id, { tolerateDown: true }) : undefined;
      this.store.upsert(config, actor);
      if (remote) await this.#deleteFromBroker(config.id, actor);
      return { store: "sandbox", config, requiredSecrets: requiredSecretNames(config) };
    }
    const view = await this.#broker.putServer(config, actor);
    this.store.rememberBrokerId(config.id);
    this.store.delete(config.id);
    return toEntry(view);
  }

  async remove(id: string, actor: string): Promise<void> {
    const removedLocal = this.store.delete(id);
    if (removedLocal) {
      // 같은 id가 broker에도 남아 있으면 지운다. broker가 안 되면 로컬 삭제만으로 끝낸다 (id는 하나만 쓰인다).
      if (this.store.knownBrokerId(id)) await this.#deleteFromBroker(id, actor).catch(() => false);
      return;
    }
    if (!(await this.#deleteFromBroker(id, actor))) throw notFound(`MCP server '${id}' not found`);
  }

  async setSecret(id: string, name: unknown, body: unknown, actor: string): Promise<void> {
    const secretName = SecretName.safeParse(name);
    if (!secretName.success) throw badRequest("secret name must match [A-Za-z0-9_.-]{1,64}");
    const parsed = PutSecretRequest.safeParse(body);
    // 값 자체는 오류 메시지에 넣지 않는다.
    if (!parsed.success) throw badRequest("body must be { value: string } (1..65536 chars)");
    if (this.store.get(id)) throw badRequest("sandbox servers cannot hold secrets; switch the server to runIn=broker");
    await this.#broker.putSecret(id, secretName.data, parsed.data.value, actor);
  }

  async deleteSecret(id: string, name: unknown, actor: string): Promise<void> {
    const secretName = SecretName.safeParse(name);
    if (!secretName.success) throw badRequest("secret name must match [A-Za-z0-9_.-]{1,64}");
    if (this.store.get(id)) throw badRequest("sandbox servers cannot hold secrets");
    await this.#broker.deleteSecret(id, secretName.data, actor);
  }

  async test(id: string, user: string | undefined, actor: string): Promise<z.infer<typeof TestServerResponse> & { note?: string }> {
    const local = this.store.get(id);
    if (local) return this.#staticCheck(local);
    return this.#broker.test(id, user, actor);
  }

  async tools(id: string, user: string | undefined): Promise<ToolSummary[]> {
    if (this.store.get(id)) {
      throw new PlatformError(400, "not_available", "sandbox servers start on first use in a session; tools cannot be listed here");
    }
    return this.#broker.tools(id, user);
  }

  async audit(limit: number): Promise<AuditEvent[]> {
    return this.#broker.audit(limit);
  }

  // ── plugin 연동 ────────────────────────────────────────────────

  /** broker에 연결되는지 확인한다. 안 되면 503. */
  async assertBrokerReachable(): Promise<void> {
    await this.#listBroker();
  }

  /**
   * id를 쓰는 서버의 현재 설정. broker가 안 되면 503이다.
   * tolerateDown이면 마지막으로 본 broker id 목록에 없는 id는 broker에 없는 것으로 본다.
   */
  async currentConfig(id: string, options: { tolerateDown?: boolean } = {}): Promise<McpServerConfig | undefined> {
    return this.store.get(id) ?? (await this.#brokerEntry(id, options))?.config;
  }

  /**
   * plugin이 등록하는 서버. 같은 plugin이 이미 등록한 서버가 있으면, 지난번 매핑(baseline)과 비교해
   * 관리자가 실제로 바꾼 값만 유지한다 (mergeWithBaseline).
   */
  async upsertPluginServer(mapped: McpServerConfig, actor: string, baseline: McpServerConfig | null): Promise<McpServerEntry> {
    const existing = await this.currentConfig(mapped.id, { tolerateDown: mapped.runIn === "sandbox" });
    let next = mapped;
    if (existing) {
      const sameOwner =
        existing.source.kind === "plugin" && mapped.source.kind === "plugin" && existing.source.pluginId === mapped.source.pluginId;
      if (!sameOwner) throw new PlatformError(409, "mcp_id_taken", `MCP server id '${mapped.id}' is already used by another server`);
      // 지난 매핑이 없으면 관리자가 바꾼 값을 알 수 없으므로 새 매핑을 쓴다
      if (baseline) next = mergeWithBaseline(baseline, existing, mapped);
    }
    return this.upsert(next, actor);
  }

  /**
   * 이 plugin이 등록한 서버. broker: false면 broker에 묻지 않는다 (plugin 기록상 broker 서버가 없을 때).
   * broker에 물어야 하는데 안 되면 503.
   */
  async pluginServers(pluginId: string, options: { broker?: boolean } = {}): Promise<McpServerEntry[]> {
    const owned = (c: McpServerConfig) => c.source.kind === "plugin" && c.source.pluginId === pluginId;
    const local: McpServerEntry[] = this.store.listByPlugin(pluginId).map((config) => ({
      store: "sandbox",
      config,
      requiredSecrets: requiredSecretNames(config),
    }));
    const remote = options.broker !== false ? (await this.#listBroker()).filter((v) => owned(v.config)).map(toEntry) : [];
    return [...local, ...remote];
  }

  /** id가 다른 서버에 쓰이고 있는지 (broker가 안 되면 503, tolerateDown이면 기억한 broker id로 판단) */
  async isIdTaken(id: string, options: { tolerateDown?: boolean } = {}): Promise<boolean> {
    return (await this.currentConfig(id, options)) !== undefined;
  }

  async setPluginServersEnabled(pluginId: string, enabled: boolean, actor: string, options: { broker?: boolean } = {}): Promise<void> {
    for (const entry of await this.pluginServers(pluginId, options)) {
      if (entry.config.enabled === enabled) continue;
      await this.upsert({ ...entry.config, enabled }, actor);
    }
  }

  /**
   * plugin이 등록한 서버를 모두 지운다. broker 쪽을 먼저 지우고, 안 되면 아무것도 지우지 않고 503.
   * broker: false면 broker에 묻지 않는다 (plugin 기록상 broker 서버가 없을 때).
   */
  async removePluginServers(pluginId: string, actor: string, options: { broker?: boolean } = {}): Promise<string[]> {
    const removed: string[] = [];
    if (options.broker !== false) {
      for (const view of await this.#listBroker()) {
        if (view.config.source.kind === "plugin" && view.config.source.pluginId === pluginId) {
          await this.#deleteFromBroker(view.config.id, actor);
          removed.push(view.config.id);
        }
      }
    }
    for (const config of this.store.listByPlugin(pluginId)) {
      this.store.delete(config.id);
      removed.push(config.id);
    }
    return removed;
  }

  // ── 내부 ───────────────────────────────────────────────────────

  /**
   * broker의 서버 하나 (없으면 undefined). broker가 안 되면 503.
   * tolerateDown이면 마지막으로 본 broker id 목록에 없는 id는 없는 것으로 보고, 있으면 503을 그대로 던진다.
   */
  async #brokerEntry(id: string, options: { tolerateDown?: boolean } = {}): Promise<McpServerEntry | undefined> {
    try {
      const view = await this.#broker.getServer(id);
      if (view) this.store.rememberBrokerId(id);
      else this.store.forgetBrokerId(id);
      return view ? toEntry(view) : undefined;
    } catch (error) {
      if (options.tolerateDown && error instanceof BrokerError && error.code === "broker_unavailable" && !this.store.knownBrokerId(id)) {
        this.#log.warn({ id }, "broker unavailable; id is not a known broker server, continuing with the sandbox change");
        return undefined;
      }
      throw error;
    }
  }

  async #listBroker(): Promise<McpServerView[]> {
    const views = await this.#broker.listServers();
    this.store.replaceBrokerIds(views.map((v) => v.config.id));
    return views;
  }

  async #deleteFromBroker(id: string, actor: string): Promise<boolean> {
    const removed = await this.#broker.deleteServer(id, actor);
    this.store.forgetBrokerId(id);
    return removed;
  }

  /** sandbox 서버는 세션에서 처음 쓸 때 시작되므로, 여기서는 설정과 plugin 파일만 확인한다. */
  #staticCheck(config: McpServerConfig): z.infer<typeof TestServerResponse> & { note: string } {
    const started = Date.now();
    const note = "sandbox 서버는 세션에서 처음 사용할 때 사용자 sandbox 안에서 시작됩니다. 여기서는 설정과 파일만 확인했습니다.";
    if (config.transport.type === "stdio") {
      const prefix = this.#pluginsDir.endsWith("/") ? this.#pluginsDir : `${this.#pluginsDir}/`;
      for (const value of [config.transport.command, ...config.transport.args]) {
        if (value.startsWith(prefix) && !existsSync(value)) {
          return { ok: false, error: `file not found: ${value}`, durationMs: Date.now() - started, note };
        }
      }
    }
    return { ok: true, durationMs: Date.now() - started, note };
  }
}

// ── plugin 서버 병합 ────────────────────────────────────────────────

const SCOPE_RANK: Record<McpScope, number> = { shared: 0, "per-user": 1, "per-session": 2 };

const eq = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

/** 세 값 병합: 현재 값이 baseline과 같으면(관리자가 안 바꿨으면) 새 매핑을, 다르면 현재 값을 쓴다. */
function pick<T>(current: T, base: T, mapped: T): T {
  return eq(current, base) ? mapped : current;
}

function mergeMap(
  current: Record<string, string>,
  base: Record<string, string>,
  mapped: Record<string, string>,
  pluginOwned: (key: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(mapped)])) {
    const inC = key in current;
    const inB = key in base;
    const inM = key in mapped;
    let value: string | undefined;
    if (pluginOwned(key)) value = mapped[key];
    else if (inC && inB && current[key] === base[key]) value = mapped[key]; // 안 바꿈 → 새 값 (plugin이 지웠으면 없앤다)
    else if (inC) value = current[key]; // 관리자가 넣거나 바꿈
    else if (inB) value = inM && mapped[key] !== base[key] ? mapped[key] : undefined; // 관리자가 지움: plugin이 값을 바꿨을 때만 되살린다
    else if (inM) value = mapped[key]; // plugin이 새로 추가
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * plugin 업데이트 병합. baseline은 지난번 설치 때의 매핑 결과(관리자 수정 전)다.
 * - 관리자가 바꾼 값(현재 ≠ baseline)은 유지하고, 그 밖에는 새 매핑을 쓴다.
 * - command·args·cwd·url과 CLAUDE_PLUGIN_* env는 항상 새 매핑을 쓴다.
 */
export function mergeWithBaseline(base: McpServerConfig, current: McpServerConfig, mapped: McpServerConfig): McpServerConfig {
  const merged: McpServerConfig = {
    ...mapped,
    enabled: pick(current.enabled, base.enabled, mapped.enabled),
    scope: pick(current.scope, base.scope, mapped.scope),
    timeoutSec: pick(current.timeoutSec, base.timeoutSec, mapped.timeoutSec),
  };
  for (const key of ["toolAllow", "toolDeny", "displayName", "description"] as const) {
    const value = pick(current[key], base[key], mapped[key]);
    if (value === undefined) delete merged[key];
    else (merged as Record<string, unknown>)[key] = value;
  }
  if (current.transport.type === "stdio" && mapped.transport.type === "stdio" && merged.transport.type === "stdio") {
    const baseEnv = base.transport.type === "stdio" ? base.transport.env : {};
    merged.transport = {
      ...merged.transport,
      env: mergeMap(current.transport.env, baseEnv, mapped.transport.env, (k) => k.startsWith("CLAUDE_PLUGIN_")),
    };
  }
  if (current.transport.type === "http" && mapped.transport.type === "http" && merged.transport.type === "http") {
    const baseHeaders = base.transport.type === "http" ? base.transport.headers : {};
    merged.transport = { ...merged.transport, headers: mergeMap(current.transport.headers, baseHeaders, mapped.transport.headers, () => false) };
  }
  // 템플릿이 요구하는 최소 scope보다 낮으면 올린다 (예: 관리자가 shared로 둔 서버에 plugin이 {{metadata}}를 추가).
  const refs = collectTemplateRefs(merged).refs;
  if (merged.transport.type === "stdio") {
    const min: McpScope = refs.some((r) => r.kind === "session" || r.kind === "metadata")
      ? "per-session"
      : refs.some((r) => r.kind === "user" || r.kind === "header")
        ? "per-user"
        : "shared";
    if (SCOPE_RANK[merged.scope] < SCOPE_RANK[min]) merged.scope = min;
  }
  return merged;
}

function describe(error: unknown): string {
  if (error instanceof PlatformError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
