import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  atLeastScope,
  findLiteralCredentials,
  McpServerConfig,
  PutSecretRequest,
  requiredScope,
  requiredSecretNames,
  SecretName,
  type McpServerStatus,
  type McpServerView,
  type SecretInfo,
  type TestServerResponse,
  type ToolSummary,
  transportTarget,
  type VisibleServer,
} from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import { badRequest, notFound, PlatformError } from "../admin/errors.js";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { Db } from "../db.js";
import { BrokerClient } from "./broker-client.js";
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

const SANDBOX_CREDENTIAL_HINT =
  "sandbox 서버의 env는 agent에게 보이므로 자격증명을 넣을 수 없습니다. 자격증명이 필요한 서버는 HTTP로 띄워 runIn=broker로 등록하고 {{secret:NAME}}을 쓰세요";

function issuesMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
}

/** 스키마 밖의 규칙. upsert와 validate가 같은 규칙을 쓴다. */
export function policyProblems(config: McpServerConfig): string[] {
  const problems = findLiteralCredentials(config).map((p) => (config.runIn === "sandbox" ? `${p} — ${SANDBOX_CREDENTIAL_HINT}` : p));
  if (config.runIn === "broker" && config.id === "servers") problems.push("id 'servers' is reserved by the broker");
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
  readonly #log: Logger;
  readonly #pluginsDir: string;

  constructor(db: Db, config: Pick<GatewayConfig, "broker" | "pluginsDir">, log: Logger) {
    this.store = new SandboxServerStore(db, log);
    this.#broker = new BrokerClient(config.broker);
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
      servers.push(...views.map(toEntry));
      broker.available = true;
    } catch (error) {
      broker.error = describe(error);
    }
    servers.sort((a, b) => a.config.id.localeCompare(b.config.id));
    return { servers, broker };
  }

  /**
   * 저장하기 전 검사. clearsSecrets는 이 설정으로 저장하면 broker가 지울 비밀키 이름이다
   * (같은 id의 broker 서버가 실행 대상(url origin·헤더)을 바꾸거나 sandbox로 옮길 때).
   */
  async validate(input: unknown): Promise<{ ok: boolean; errors: string[]; requiredSecrets: string[]; clearsSecrets: string[] }> {
    const result = McpServerConfig.safeParse(input);
    if (!result.success) {
      return { ok: false, errors: result.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`), requiredSecrets: [], clearsSecrets: [] };
    }
    const config = result.data;
    const errors = policyProblems(config);
    // broker가 안 되면 알 수 없다. 저장도 503으로 실패하므로 검사는 막지 않는다.
    const current = this.store.get(config.id) ? undefined : await this.#brokerEntry(config.id).catch(() => undefined);
    const moved = current !== undefined && (config.runIn !== "broker" || transportTarget(current.config) !== transportTarget(config));
    const clearsSecrets = moved ? (current.secrets ?? []).map((s) => s.name) : [];
    return { ok: errors.length === 0, errors, requiredSecrets: requiredSecretNames(config), clearsSecrets };
  }

  /** 만들거나 바꾼다. runIn이 바뀌면 다른 저장소로 옮긴다. */
  async upsert(input: unknown, actor: string): Promise<McpServerEntry> {
    const parsed = McpServerConfig.safeParse(input);
    if (!parsed.success) throw badRequest(issuesMessage(parsed.error), parsed.error.issues);
    const config = parsed.data;
    const problems = policyProblems(config);
    if (problems.length > 0) throw badRequest(problems.join("; "), problems);
    if (config.runIn === "sandbox") {
      // 새 id면 broker에 같은 id가 있는지 본다 (있으면 옮기는 것이라 broker 쪽을 지운다). 이미 sandbox 서버면 묻지 않는다
      // (id는 한 저장소에만 둔다). broker가 안 되면 503이다.
      const remote = this.store.get(config.id) ? undefined : await this.#brokerEntry(config.id);
      this.store.upsert(config, actor);
      if (remote) await this.#broker.deleteServer(config.id, actor);
      return { store: "sandbox", config, requiredSecrets: requiredSecretNames(config) };
    }
    const view = await this.#broker.putServer(config, actor);
    this.store.delete(config.id);
    return toEntry(view);
  }

  async remove(id: string, actor: string): Promise<void> {
    // sandbox 서버의 id는 broker에 없다 (upsert가 한 저장소에만 둔다).
    if (this.store.delete(id)) return;
    if (!(await this.#broker.deleteServer(id, actor))) throw notFound(`MCP server '${id}' not found`);
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

  // ── plugin 연동 ────────────────────────────────────────────────

  /** broker에 연결되는지 확인한다. 안 되면 503. */
  async assertBrokerReachable(): Promise<void> {
    await this.#broker.listServers();
  }

  /** id를 쓰는 서버의 현재 설정. broker가 안 되면 503이다. */
  async currentConfig(id: string): Promise<McpServerConfig | undefined> {
    return this.store.get(id) ?? (await this.#brokerEntry(id))?.config;
  }

  /**
   * plugin이 등록하는 서버. 같은 plugin이 이미 등록한 서버가 있으면, 지난번 매핑(baseline)과 비교해
   * 관리자가 실제로 바꾼 값만 유지한다 (mergeWithBaseline).
   */
  async upsertPluginServer(mapped: McpServerConfig, actor: string, baseline: McpServerConfig | null): Promise<McpServerEntry> {
    const existing = await this.currentConfig(mapped.id);
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
    const remote = options.broker !== false ? (await this.#broker.listServers()).filter((v) => owned(v.config)).map(toEntry) : [];
    return [...local, ...remote];
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
      for (const view of await this.#broker.listServers()) {
        if (view.config.source.kind === "plugin" && view.config.source.pluginId === pluginId) {
          await this.#broker.deleteServer(view.config.id, actor);
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

  /** broker의 서버 하나 (없으면 undefined). broker가 안 되면 503. */
  async #brokerEntry(id: string): Promise<McpServerEntry | undefined> {
    const view = await this.#broker.getServer(id);
    return view ? toEntry(view) : undefined;
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
  if (merged.transport.type === "stdio") merged.scope = atLeastScope(merged.scope, requiredScope(merged));
  return merged;
}

function describe(error: unknown): string {
  if (error instanceof PlatformError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
