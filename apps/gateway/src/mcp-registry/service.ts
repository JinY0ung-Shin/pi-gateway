import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  atLeastScope,
  findLiteralCredentials,
  McpServerConfig,
  requiredHeaderNames,
  requiredScope,
  requiredSecretNames,
  type McpServerStatus,
  type McpServerView,
  type SecretInfo,
  type TestServerResponse,
  transportTarget,
  type VisibleServer,
} from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import { badRequest, describe, issueList, notFound } from "../admin/errors.js";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { Db } from "../db.js";
import { BrokerClient } from "./broker-client.js";
import { SandboxServerStore } from "./store.js";

type McpStore = "sandbox" | "broker";

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

/** 스키마 밖의 규칙. upsert와 validate가 같은 규칙을 쓴다. */
function policyProblems(config: McpServerConfig): string[] {
  const problems = findLiteralCredentials(config).map((p) => (config.runIn === "sandbox" ? `${p} — ${SANDBOX_CREDENTIAL_HINT}` : p));
  if (config.runIn === "broker" && config.id === "servers") problems.push("id 'servers' is reserved by the broker");
  return problems;
}

/** plugin이 등록한 서버인지 */
export function ownedByPlugin(config: Pick<McpServerConfig, "source">, pluginId: string): boolean {
  return config.source.kind === "plugin" && config.source.pluginId === pluginId;
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
  /** forwardHeaders 결과. broker 서버를 바꾸면 비운다 (broker 서버는 이 gateway로만 바뀐다). */
  #forwardHeaders: Promise<string[]> | undefined;

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

  forwardHeaders(): Promise<string[]> {
    if (!this.#forwardHeaders) {
      const loading: Promise<string[]> = this.#broker.listServers().then(
        (views) => [...new Set(views.flatMap((v) => requiredHeaderNames(v.config)))].sort(),
        (error) => {
          // 실패는 기억하지 않는다. 다음 요청이 다시 묻는다.
          if (this.#forwardHeaders === loading) this.#forwardHeaders = undefined;
          this.#log.warn({ err: describe(error) }, "could not list MCP servers from the broker; forwarding no client headers");
          return [];
        },
      );
      this.#forwardHeaders = loading;
    }
    return this.#forwardHeaders;
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
      return { ok: false, errors: issueList(result.error, "config"), requiredSecrets: [], clearsSecrets: [] };
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
  async upsert(input: unknown): Promise<McpServerEntry> {
    const config = validated(input);
    // sandbox로 저장하는 새 id면 broker에 같은 id가 있는지 본다 (있으면 옮기는 것이라 broker 쪽을 지운다).
    // 이미 sandbox 서버면 묻지 않는다 (id는 한 저장소에만 둔다). broker가 안 되면 503이다.
    const inBroker = config.runIn === "sandbox" && !this.store.get(config.id) && (await this.#brokerEntry(config.id)) !== undefined;
    return this.#save(config, inBroker);
  }

  async remove(id: string): Promise<void> {
    // sandbox 서버의 id는 broker에 없다 (upsert가 한 저장소에만 둔다).
    if (this.store.delete(id)) return;
    if (!(await this.#deleteBrokerServer(id))) throw notFound(`MCP server '${id}' not found`);
  }

  /** 비밀키 이름과 값은 broker가 검사한다 (오류 메시지에 값을 넣지 않는다). */
  async setSecret(id: string, name: string, body: unknown): Promise<void> {
    if (this.store.get(id)) throw badRequest("sandbox servers cannot hold secrets; switch the server to runIn=broker");
    await this.#broker.putSecret(id, name, body);
  }

  async deleteSecret(id: string, name: string): Promise<void> {
    if (this.store.get(id)) throw badRequest("sandbox servers cannot hold secrets");
    await this.#broker.deleteSecret(id, name);
  }

  async test(id: string): Promise<z.infer<typeof TestServerResponse>> {
    const local = this.store.get(id);
    if (local) return this.#staticCheck(local);
    return this.#broker.test(id);
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
   * plugin이 등록하는 서버. current는 그 id의 현재 설정이다 (부른 쪽이 currentConfig로 읽었고, 같은 plugin의 서버다).
   * 있으면 지난번 매핑(baseline)과 비교해 관리자가 실제로 바꾼 값만 유지한다 (mergeWithBaseline).
   */
  async upsertPluginServer(mapped: McpServerConfig, baseline: McpServerConfig | null, current: McpServerConfig | undefined): Promise<McpServerEntry> {
    // 지난 매핑이 없으면 관리자가 바꾼 값을 알 수 없으므로 새 매핑을 쓴다
    const config = validated(current && baseline ? mergeWithBaseline(baseline, current, mapped) : mapped);
    // broker에 저장된 설정은 runIn이 broker다 (sandbox 설정은 gateway DB에만 있다).
    return this.#save(config, current?.runIn === "broker");
  }

  /**
   * 이 plugin이 등록한 서버. broker: false면 broker에 묻지 않는다 (plugin 기록상 broker 서버가 없을 때).
   * broker에 물어야 하는데 안 되면 503.
   */
  async pluginServers(pluginId: string, options: { broker?: boolean } = {}): Promise<McpServerEntry[]> {
    const local: McpServerEntry[] = this.store.listByPlugin(pluginId).map((config) => ({
      store: "sandbox",
      config,
      requiredSecrets: requiredSecretNames(config),
    }));
    const remote = options.broker !== false ? (await this.#broker.listServers()).filter((v) => ownedByPlugin(v.config, pluginId)).map(toEntry) : [];
    return [...local, ...remote];
  }

  async setPluginServersEnabled(pluginId: string, enabled: boolean, options: { broker?: boolean } = {}): Promise<void> {
    for (const entry of await this.pluginServers(pluginId, options)) {
      if (entry.config.enabled === enabled) continue;
      await this.upsert({ ...entry.config, enabled });
    }
  }

  /**
   * plugin이 등록한 서버를 모두 지운다. broker 쪽을 먼저 지우고, 안 되면 아무것도 지우지 않고 503.
   * broker: false면 broker에 묻지 않는다 (plugin 기록상 broker 서버가 없을 때).
   */
  async removePluginServers(pluginId: string, options: { broker?: boolean } = {}): Promise<void> {
    const entries = await this.pluginServers(pluginId, options);
    for (const e of entries) if (e.store === "broker") await this.#deleteBrokerServer(e.config.id);
    for (const e of entries) if (e.store === "sandbox") this.store.delete(e.config.id);
  }

  // ── 내부 ───────────────────────────────────────────────────────

  /** 검사를 마친 설정을 저장한다. inBroker: 같은 id의 broker 서버가 있다 (sandbox로 옮기면 지운다). */
  async #save(config: McpServerConfig, inBroker: boolean): Promise<McpServerEntry> {
    if (config.runIn === "sandbox") {
      this.store.upsert(config);
      if (inBroker) await this.#deleteBrokerServer(config.id);
      return { store: "sandbox", config, requiredSecrets: requiredSecretNames(config) };
    }
    const view = await this.#broker.putServer(config);
    this.#forwardHeaders = undefined;
    this.store.delete(config.id);
    return toEntry(view);
  }

  async #deleteBrokerServer(id: string): Promise<boolean> {
    const deleted = await this.#broker.deleteServer(id);
    this.#forwardHeaders = undefined;
    return deleted;
  }

  /** broker의 서버 하나 (없으면 undefined). broker가 안 되면 503. */
  async #brokerEntry(id: string): Promise<McpServerEntry | undefined> {
    const view = await this.#broker.getServer(id);
    return view ? toEntry(view) : undefined;
  }

  /** sandbox 서버는 세션에서 처음 쓸 때 시작되므로, 여기서는 설정과 plugin 파일만 확인한다. */
  #staticCheck(config: McpServerConfig): TestServerResponse {
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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** 스키마와 정책(policyProblems) 검사를 거친 설정. 맞지 않으면 400. */
function validated(input: unknown): McpServerConfig {
  const parsed = McpServerConfig.safeParse(input);
  if (!parsed.success) throw badRequest(issueList(parsed.error, "config").join("; "));
  const problems = policyProblems(parsed.data);
  if (problems.length > 0) throw badRequest(problems.join("; "));
  return parsed.data;
}

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
    // plugin이 url의 origin을 바꿨으면 관리자가 넣은 헤더(사용자별 헤더 등)를 새 곳으로 보내지 않고 새 매핑을 쓴다
    if (base.transport.type === "http" && originOf(base.transport.url) === originOf(mapped.transport.url)) {
      merged.transport = { ...merged.transport, headers: mergeMap(current.transport.headers, base.transport.headers, mapped.transport.headers, () => false) };
    }
  }
  // 템플릿이 요구하는 최소 scope보다 낮으면 올린다 (예: 관리자가 shared로 둔 서버에 plugin이 {{metadata}}를 추가).
  if (merged.transport.type === "stdio") merged.scope = atLeastScope(merged.scope, requiredScope(merged));
  return merged;
}

