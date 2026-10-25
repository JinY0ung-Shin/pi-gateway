import { createHash } from "node:crypto";
import { DEFAULT_MAX_BYTES, formatSize, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpClient, McpHttpError, McpSessionExpiredError, StreamableHttpTransport, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import {
  AUD_BROKER,
  isToolAllowed,
  type McpServerConfig,
  mcpToolName,
  type RequestContext,
  renderTemplate,
  SANDBOX_WORKSPACE,
  signInternalToken,
} from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { SandboxHandle } from "../sandbox/client.js";
import { guardImageBlocks } from "../tools/image-guard.js";
import { AttachedStdioTransport } from "./attached-transport.js";

/**
 * 한 세션이 MCP 서버들에 맺는 연결.
 * - broker 서버: pi-mcp McpClient → `${BROKER_URL}/mcp/<id>`. 요청마다 새 내부 JWT를 붙인다.
 *   비밀키는 broker에만 있고 gateway는 모른다.
 * - sandbox 서버: sandboxd attach로 사용자 컨테이너 안에 stdio 프로세스를 띄운다.
 *   비밀키가 없는 서버만 여기서 돈다 (shared mcp-config 검증 규칙).
 * 도구 목록은 프로세스 전역 캐시를 쓰고, 연결은 처음 필요할 때 만든다.
 */

const CLIENT_INFO = { name: "pi-gateway", version: "0.1.0" };

/** broker가 서버별 제한 시간을 먼저 적용하므로, gateway 쪽은 조금 더 기다린다. */
const BROKER_TIMEOUT_MARGIN_SEC = 15;

const requestTimeoutMs = (server: McpServerHandle) =>
  (server.timeoutSec + (server.kind === "broker" ? BROKER_TIMEOUT_MARGIN_SEC : 0)) * 1000;

/** sandbox MCP 서버의 PATH: 시스템 디렉토리만 (sandbox 기본 PATH의 workspace 디렉토리를 빼서 하이재킹을 막는다). */
export const SANDBOX_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** sandbox MCP 서버 기본 env. 서버 설정의 env가 같은 이름을 주면 그 값이 이긴다 (관리자 설정). */
export const SANDBOX_MCP_BASE_ENV: Readonly<Record<string, string>> = {
  PATH: SANDBOX_SYSTEM_PATH,
  // python이 workspace의 user site-packages(~/.local)를 import하지 않게 한다 (sitecustomize 심기 방지).
  PYTHONNOUSERSITE: "1",
  NODE_OPTIONS: "",
};

/**
 * 명령 이름(`node` 등)을 sandbox의 시스템 디렉토리에서 찾아 절대 경로로 바꾼다.
 * 시스템 디렉토리는 읽기 전용이라 agent가 바꿀 수 없다. 경로(`/`가 들어간 값)는 그대로 쓴다.
 */
export async function resolveSandboxCommand(sandbox: Pick<SandboxHandle, "stat">, command: string): Promise<string> {
  if (command.includes("/")) return command;
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) throw new Error(`invalid MCP server command '${command}'`);
  for (const dir of SANDBOX_SYSTEM_PATH.split(":")) {
    const candidate = `${dir}/${command}`;
    const st = await sandbox.stat(candidate);
    if (st.exists && (st.kind === "file" || st.kind === "symlink")) return candidate;
  }
  throw new Error(`MCP server command '${command}' was not found in the sandbox system PATH (${SANDBOX_SYSTEM_PATH})`);
}

/** plugin 설치 때 `${CLAUDE_PLUGIN_DATA}`가 이 아래 경로로 바뀐다 (plugin별 영구 데이터 디렉토리). */
const PLUGIN_DATA_DIR = /\/workspace\/\.home\/\.plugin-data\/[A-Za-z0-9._-]+/g;

/** 문자열들이 참조하는 plugin 데이터 디렉토리 */
export function pluginDataDirs(values: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const v of values) for (const m of v.matchAll(PLUGIN_DATA_DIR)) dirs.add(m[0]);
  return [...dirs].sort();
}

export interface McpServerHandle {
  kind: "broker" | "sandbox";
  id: string;
  displayName?: string;
  description?: string;
  timeoutSec: number;
  /** sandbox 서버의 설정 (broker 서버는 broker가 설정을 가진다) */
  config?: McpServerConfig;
}

/** 도구 목록 캐시 (프로세스 전역) */
export class McpToolCache {
  private readonly entries = new Map<string, { at: number; tools: Tool[] }>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  get(key: string): Tool[] | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.tools;
  }

  set(key: string, tools: Tool[]): void {
    this.entries.set(key, { at: Date.now(), tools });
  }
}

export interface McpConnectionDeps {
  broker: GatewayConfig["broker"];
  sandbox: SandboxHandle;
  principal: string;
  sessionId: string;
  /** 현재 요청의 전달 헤더·metadata (allowlist를 거친 값) */
  requestContext: () => RequestContext;
  cache: McpToolCache;
  log: Logger;
  /** 서버 하나의 도구 목록을 기다리는 최대 시간 (기본 MCP_LIST_TIMEOUT_MS) */
  listTimeoutMs?: number;
}

/** tool_execution_update의 details. SSE `response.tool_progress`(source=mcp)로 바뀐다. */
export interface McpProgressDetails {
  mcpProgress: { progress: number; total?: number; message?: string };
}

function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  return { ...schema, type: schema.type ?? "object", ...(schema.properties === undefined ? { properties: {} } : {}) };
}

function configHash(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(config.transport)).digest("hex").slice(0, 16);
}

/** 세션을 만들 때 서버 하나의 도구 목록을 기다리는 최대 시간. 넘으면 그 서버는 이번 세션에서 빠진다. */
export const MCP_LIST_TIMEOUT_MS = 15_000;

/** promise를 signal과 경쟁시킨다 (promise 자체는 취소되지 않는다). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * 요청이 서버에 전달되지 않은 것이 확실한 오류인가 (그때만 다시 보낸다).
 * - 세션 만료·404: 서버(broker)가 요청을 처리하지 않고 거절했다.
 * - 연결 자체가 안 됨(ECONNREFUSED 등): 요청이 나가지 않았다.
 * 시간 초과, JSON-RPC 오류, 처리 중 연결 끊김은 서버가 이미 실행했을 수 있으므로 다시 보내지 않는다.
 */
export function wasNotDispatched(err: unknown): boolean {
  if (err instanceof McpSessionExpiredError) return true;
  // broker는 모르는·꺼진 서버 요청을 upstream에 보내지 않고 404로 거절한다.
  if (err instanceof McpHttpError && err.status === 404) return true;
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NOT_CONNECTED_CODES.has(code)) return true;
  }
  return false;
}

export class McpConnectionSet {
  private readonly clients = new Map<string, Promise<McpClient>>();
  /** 세션이 정리되면 abort된다: 진행 중인 attach·연결 시도를 끊는다. */
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(private readonly deps: McpConnectionDeps) {}

  /**
   * 서버들의 도구 정의. 서버마다 병렬로, 각자 제한 시간 안에서 목록을 가져온다.
   * 실패하거나 늦은 서버는 경고만 남기고 이번 세션에서 뺀다 (턴을 막지 않는다).
   */
  async tools(servers: McpServerHandle[], signal?: AbortSignal): Promise<ToolDefinition[]> {
    const sorted = [...servers].sort((a, b) => a.id.localeCompare(b.id));
    const listed = await Promise.allSettled(
      sorted.map((server) =>
        withTimeout(
          raceAbort(this.listTools(server, signal), signal),
          Math.min(this.deps.listTimeoutMs ?? MCP_LIST_TIMEOUT_MS, requestTimeoutMs(server)),
          `tools/list of ${server.id}`,
        ),
      ),
    );
    const definitions: ToolDefinition[] = [];
    const seen = new Set<string>();
    listed.forEach((result, i) => {
      const server = sorted[i]!;
      if (result.status === "rejected") {
        // 늦거나 실패한 연결은 버린다. 다음 사용 때 새로 연결한다.
        this.drop(server);
        this.deps.log.warn({ err: result.reason, server: server.id, kind: server.kind }, "MCP tools/list failed; server skipped");
        return;
      }
      for (const tool of [...result.value].sort((a, b) => a.name.localeCompare(b.name))) {
        if (server.config && !isToolAllowed(server.config, tool.name)) continue;
        const name = mcpToolName(server.id, tool.name);
        if (seen.has(name)) continue;
        seen.add(name);
        definitions.push(this.toolDefinition(server, tool, name));
      }
    });
    return definitions;
  }

  /**
   * 도구 목록 캐시 키. 사용자 사이에 목록을 절대 공유하지 않는다:
   * - broker 서버: 사용자마다 자격 증명이 달라 보이는 도구가 다를 수 있다 → principal별.
   * - sandbox 서버: 목록이 그 사용자의 sandbox에서 만들어지므로(그 사용자가 영향을 줄 수 있다)
   *   principal별, per-session이면 세션별까지.
   */
  private cacheKey(server: McpServerHandle): string {
    const principal = this.deps.principal;
    if (server.kind === "broker") return `broker:${server.id}:${principal}`;
    const base = `sandbox:${server.id}:${configHash(server.config!)}:${principal}`;
    return server.config!.scope === "per-session" ? `${base}:${this.deps.sessionId}` : base;
  }

  private async listTools(server: McpServerHandle, signal?: AbortSignal): Promise<Tool[]> {
    const key = this.cacheKey(server);
    const cached = this.deps.cache.get(key);
    if (cached) return cached;
    const client = await this.client(server, signal);
    const tools = await client.listTools({ timeoutMs: requestTimeoutMs(server), ...(signal ? { signal } : {}) });
    this.deps.cache.set(key, tools);
    return tools;
  }

  private key(server: McpServerHandle): string {
    return `${server.kind}:${server.id}`;
  }

  private drop(server: McpServerHandle): void {
    const key = this.key(server);
    const pending = this.clients.get(key);
    this.clients.delete(key);
    void pending?.then((c) => c.close()).catch(() => {});
  }

  /** 연결된 client. 연결 시도는 세션 안에서 공유하고, 호출하는 쪽은 자기 signal로만 기다린다. */
  private client(server: McpServerHandle, signal?: AbortSignal): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error("MCP connections of this session are closed"));
    const key = this.key(server);
    let pending = this.clients.get(key);
    if (!pending) {
      pending = this.connect(server, key).catch((err) => {
        if (this.clients.get(key) === pending) this.clients.delete(key);
        throw err;
      });
      this.clients.set(key, pending);
    }
    return raceAbort(pending, signal);
  }

  private async connect(server: McpServerHandle, key: string): Promise<McpClient> {
    const client = new McpClient({ ...CLIENT_INFO, requestTimeoutMs: requestTimeoutMs(server) });
    if (server.kind === "broker") {
      const broker = this.deps.broker;
      if (!broker) throw new Error("MCP broker is not configured");
      const transport = new StreamableHttpTransport({
        url: `${broker.url}/mcp/${encodeURIComponent(server.id)}`,
        openGetStream: false,
        authProvider: {
          token: () =>
            signInternalToken(broker.jwtSecret, AUD_BROKER, {
              sub: this.deps.principal,
              sid: this.deps.sessionId,
              ctx: this.deps.requestContext(),
            }),
        },
      });
      await client.connect(transport);
    } else {
      const config = server.config!;
      if (config.transport.type !== "stdio") throw new Error(`sandbox MCP server ${server.id} must use stdio`);
      const metadata = this.deps.requestContext().metadata;
      // sandbox 서버에는 비밀·헤더 자리표시자가 없다 (설정 검증에서 거른다). 사용자·세션·metadata만 채운다.
      const values = { user: this.deps.principal, session: this.deps.sessionId, ...(metadata ? { metadata } : {}) };
      const render = (v: string) => renderTemplate(v, values).value;
      const stdio = config.transport;
      // 명령 이름은 시스템 디렉토리에서만 찾아 절대 경로로 띄운다 (workspace에 심은 같은 이름의 실행 파일 무시).
      const command = await resolveSandboxCommand(this.deps.sandbox, render(stdio.command));
      const argv = [command, ...stdio.args.map(render)];
      const env = { ...SANDBOX_MCP_BASE_ENV, ...Object.fromEntries(Object.entries(stdio.env).map(([k, v]) => [k, render(v)])) };
      const cwd = stdio.cwd ? render(stdio.cwd) : SANDBOX_WORKSPACE;
      // plugin 데이터 디렉토리는 서버가 처음 뜨기 전에 만들어 둔다 (Claude Code도 hook·MCP 실행 전에 만든다).
      for (const dir of pluginDataDirs([...argv, ...Object.values(env), cwd])) await this.deps.sandbox.mkdir(dir);
      const transport = new AttachedStdioTransport(
        () => this.deps.sandbox.attach({ argv, cwd, env }, this.lifetime.signal),
        (text) => this.deps.log.debug({ server: server.id, stderr: text.slice(0, 2000) }, "sandbox MCP stderr"),
      );
      await client.connect(transport);
    }
    if (this.closed) {
      await client.close().catch(() => {});
      throw new Error("MCP connections of this session are closed");
    }
    // 연결이 끊기면 다음 호출 때 다시 연결한다.
    client.onClose(() => {
      this.clients.delete(key);
    });
    return client;
  }

  private toolDefinition(server: McpServerHandle, tool: Tool, name: string): ToolDefinition {
    const label = `${server.id}/${tool.name}`;
    return {
      name,
      label,
      description: tool.description?.trim() || tool.title || `MCP tool ${tool.name} from server ${server.displayName ?? server.id}`,
      parameters: toParameters(tool.inputSchema) as never,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const args = (params ?? {}) as Record<string, unknown>;
        const call = async () => {
          let client = await this.client(server, signal);
          // 이미 끊긴 연결이면 보내기 전에 새로 연결한다 (아직 아무것도 보내지 않았으므로 안전하다).
          if (client.connectionState !== "connected") {
            this.drop(server);
            client = await this.client(server, signal);
          }
          return client.callTool(tool.name, args, {
            ...(signal ? { signal } : {}),
            timeoutMs: requestTimeoutMs(server),
            onProgress: (p) => {
              const details: McpProgressDetails = {
                mcpProgress: {
                  progress: p.progress,
                  ...(p.total !== undefined ? { total: p.total } : {}),
                  ...(p.message ? { message: p.message } : {}),
                },
              };
              const text = p.message ?? `Progress ${p.progress}${p.total === undefined ? "" : `/${p.total}`}`;
              onUpdate?.({ content: [{ type: "text", text }], details });
            },
          });
        };
        let result;
        try {
          result = await call();
        } catch (err) {
          // 부작용이 두 번 일어나지 않도록, 요청이 나가지 않은 것이 확실할 때만 한 번 다시 보낸다.
          if (signal?.aborted || this.closed || !wasNotDispatched(err)) throw err;
          this.drop(server);
          result = await call();
        }
        // MCP 서버가 준 이미지는 pi가 gateway에서 디코딩한다. 그 전에 크기를 확인한다.
        const content = await this.spillLongText(guardImageBlocks(toLlmContent(result), `${server.id}/${tool.name}`), toolCallId, signal);
        return {
          content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
          details: { server: server.id, tool: tool.name },
          ...(result.isError ? { isError: true } : {}),
        };
      },
    };
  }

  /** 텍스트가 길면 앞부분만 모델에 주고 전체는 sandbox /tmp에 저장한다 (bash 도구와 같은 기준). */
  private async spillLongText(content: ReturnType<typeof guardImageBlocks>, toolCallId: string, signal?: AbortSignal) {
    const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    const size = Buffer.byteLength(text, "utf8");
    if (size <= DEFAULT_MAX_BYTES) return content;
    const path = `/tmp/pi-mcp-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
    let where = `Full result: ${path}`;
    try {
      await this.deps.sandbox.writeFile(path, text, signal);
    } catch {
      where = "Full result could not be saved";
    }
    const head = Buffer.from(text, "utf8").subarray(0, DEFAULT_MAX_BYTES).toString("utf8").replace(/\uFFFD$/, "");
    const notice = `[Showing the first ${formatSize(DEFAULT_MAX_BYTES)} of ${formatSize(size)}. ${where}]`;
    return [{ type: "text" as const, text: `${head}\n\n${notice}` }, ...content.filter((c) => c.type !== "text")];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (p) => (await p).close()));
  }
}
