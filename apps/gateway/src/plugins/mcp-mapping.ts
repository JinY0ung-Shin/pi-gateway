import {
  collectTemplateRefs,
  MCP_SERVER_ID_PATTERN,
  McpServerConfig,
  type McpRunIn,
  type McpScope,
  requiredSecretNames,
  SANDBOX_WORKSPACE,
} from "@pi-gateway/shared";
import { isObject, type JsonObject } from "./manifest.js";

/** plugin이 설치하는 sandbox 실행 MCP 서버에 공통으로 넣는 값 (관리 화면에서 바꾼다) */
export interface PluginMcpDefaults {
  env: Record<string, string>;
  scope: McpScope;
}

export const DEFAULT_PLUGIN_MCP_DEFAULTS: PluginMcpDefaults = {
  // oh-my-gateway는 METADATA_ENV_ALLOWLIST=THREAD_ID,ORCHESTRATOR_URL로 요청 metadata를 CLI env에 넣었고,
  // stdio MCP 서버(monsemi-frontend)가 그것을 물려받았다. 기존 클라이언트는 metadata={"THREAD_ID": …}를 보낸다.
  // gateway의 MCP_METADATA_KEYS에 THREAD_ID,ORCHESTRATOR_URL이 있어야 값이 채워진다.
  // 이 env는 그 변수 이름을 실제로 참조하는 서버에만 넣는다 (referencedDefaultEnv).
  env: { THREAD_ID: "{{metadata:THREAD_ID}}", ORCHESTRATOR_URL: "{{metadata:ORCHESTRATOR_URL}}" },
  // 기본 env를 쓰지 않는 서버는 사용자마다 하나의 프로세스를 쓴다. {{metadata}}를 쓰면 자동으로 per-session이 된다.
  scope: "per-user",
};

/** 서버 설정의 command·args 중 `${CLAUDE_PLUGIN_ROOT}/…` 파일 (plugin 기준 상대 경로) */
export function pluginEntryFiles(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const values = [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])].filter((v): v is string => typeof v === "string");
  return values.map((v) => /^\$\{CLAUDE_PLUGIN_ROOT\}\/(.+)$/.exec(v)?.[1]).filter((v): v is string => Boolean(v));
}

/**
 * 기본 env 중 이 서버가 참조하는 것만 고른다. 서버 설정이 그 env를 선언했거나,
 * 진입 파일(entryTexts: pluginEntryFiles의 내용) 안에 변수 이름이 단어로 나오면 참조한다고 본다.
 * (예: monsemi-frontend의 server.js는 process.env.THREAD_ID·ORCHESTRATOR_URL·SERVICE_URL을 읽는다.)
 */
export function referencedDefaultEnv(raw: unknown, defaultsEnv: Record<string, string>, entryTexts: string[]): Record<string, string> {
  const declared = new Set(isObject(raw) && isObject(raw.env) ? Object.keys(raw.env) : []);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaultsEnv)) {
    const word = new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`);
    if (declared.has(key) || entryTexts.some((t) => word.test(t))) out[key] = value;
  }
  return out;
}

/** 설치 요청에서 서버별로 덮어쓰는 값 */
export interface McpOverride {
  id?: string | undefined;
  env?: Record<string, string> | undefined;
  scope?: McpScope | undefined;
  enabled?: boolean | undefined;
}

export interface PluginMcpContext {
  pluginId: string;
  pluginName: string;
  version: string;
  /** 설치 경로 (gateway·sandbox·broker 공통) */
  root: string;
  /** sandbox 안에서 쓰는 plugin 데이터 디렉토리 (사용자별, workspace 안) */
  dataDir: string;
  description?: string | undefined;
  defaults: PluginMcpDefaults;
  override?: McpOverride | undefined;
}

export interface MappedMcpServer {
  /** plugin 안에서의 서버 이름 */
  name: string;
  config?: McpServerConfig;
  runIn?: McpRunIn;
  requiredSecrets: string[];
  unsupported?: string;
  /** broker가 거절하는 명령(npx 등 실행 시 다운로드)이라 미리 설치가 필요하다. 값은 원래 명령줄. */
  needsPreinstall?: string;
  warnings: string[];
}

/** broker는 실행 시 패키지를 내려받는 명령을 거절한다 (패키지는 broker 이미지에 미리 설치). */
export const BROKER_BANNED_COMMANDS = new Set(["npx", "uvx", "bunx", "pnpx", "pipx", "npm", "pnpm", "yarn"]);

const SECRETISH = /(TOKEN|KEY|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|SESSION|PAT$|PRIVATE)/i;
const CLAUDE_VAR = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g;

/** `${VAR}` 계열 Claude 변수를 gateway 템플릿으로 바꾼다. 비밀로 보이는 값은 {{secret:…}}이 된다. */
export function convertClaudeVariables(value: string, ctx: Pick<PluginMcpContext, "root" | "dataDir">): string {
  return value.replace(CLAUDE_VAR, (_whole, name: string, fallback: string | undefined) => {
    if (name === "CLAUDE_PLUGIN_ROOT") return ctx.root;
    if (name === "CLAUDE_PLUGIN_DATA") return ctx.dataDir;
    if (name === "CLAUDE_PROJECT_DIR") return SANDBOX_WORKSPACE;
    if (name.startsWith("user_config.")) return `{{secret:${name}}}`;
    if (fallback !== undefined && !SECRETISH.test(name)) return fallback;
    return `{{secret:${name}}}`;
  });
}

export function sanitizeServerId(name: string): string {
  let id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 48);
  id = id.replace(/[-_]+$/, "");
  return MCP_SERVER_ID_PATTERN.test(id) ? id : "";
}

const SCOPE_RANK: Record<McpScope, number> = { shared: 0, "per-user": 1, "per-session": 2 };

/** stdio 서버는 env·args가 시작 시 고정되므로 템플릿에 맞는 최소 scope가 정해진다. */
function requiredScope(config: Pick<McpServerConfig, "transport">): McpScope {
  if (config.transport.type !== "stdio") return "shared";
  const refs = collectTemplateRefs(config).refs;
  if (refs.some((r) => r.kind === "session" || r.kind === "metadata")) return "per-session";
  if (refs.some((r) => r.kind === "user" || r.kind === "header")) return "per-user";
  return "shared";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  return out;
}

/** plugin의 `.mcp.json`(또는 plugin.json mcpServers) 항목 하나를 gateway MCP 서버 설정으로 바꾼다. */
export function mapPluginMcpServer(name: string, raw: unknown, ctx: PluginMcpContext): MappedMcpServer {
  const warnings: string[] = [];
  if (!isObject(raw)) return { name, requiredSecrets: [], unsupported: "server config is not an object", warnings };
  const cfg: JsonObject = raw;
  const declared = typeof cfg.type === "string" ? cfg.type : undefined;
  const type = declared ?? (typeof cfg.command === "string" ? "stdio" : typeof cfg.url === "string" ? "http" : undefined);
  if (type === "sse" || type === "ws") return { name, requiredSecrets: [], unsupported: `${type} transport is not supported (streamable HTTP or stdio only)`, warnings };
  if (type !== "stdio" && type !== "http" && type !== "streamable-http") {
    return { name, requiredSecrets: [], unsupported: `unknown transport '${String(declared ?? "")}'`, warnings };
  }
  if (cfg.headersHelper !== undefined) return { name, requiredSecrets: [], unsupported: "headersHelper (command-generated headers) is not supported", warnings };
  if (cfg.oauth !== undefined) return { name, requiredSecrets: [], unsupported: "OAuth MCP servers are not supported yet", warnings };

  const conv = (v: string) => convertClaudeVariables(v, ctx);
  const override = ctx.override ?? {};
  let id = override.id ?? sanitizeServerId(name);
  if (!id) id = sanitizeServerId(`${ctx.pluginName}-mcp`);

  let config: McpServerConfig;
  let runIn: McpRunIn;
  if (type === "stdio") {
    if (typeof cfg.command !== "string" || !cfg.command.trim()) return { name, requiredSecrets: [], unsupported: "stdio server has no command", warnings };
    const command = conv(cfg.command);
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === "string").map(conv) : [];
    const pluginEnv = Object.fromEntries(Object.entries(stringRecord(cfg.env)).map(([k, v]) => [k, conv(v)]));
    const cwd = typeof cfg.cwd === "string" ? conv(cfg.cwd) : undefined;
    const draft = { type: "stdio" as const, command, args, env: pluginEnv, ...(cwd ? { cwd } : {}) };
    const needsSecrets = requiredSecretNames({ transport: draft }).length > 0;
    runIn = needsSecrets ? "broker" : "sandbox";
    const env =
      runIn === "sandbox"
        ? { ...pluginEnv, CLAUDE_PLUGIN_ROOT: ctx.root, CLAUDE_PLUGIN_DATA: ctx.dataDir, ...ctx.defaults.env, ...(override.env ?? {}) }
        : { ...pluginEnv, CLAUDE_PLUGIN_ROOT: ctx.root, ...(override.env ?? {}) };
    if (command.startsWith("npx") || command === "uvx") warnings.push(`'${command}' downloads packages at start-up; pre-install the server instead if possible`);
    const requested: McpScope = override.scope ?? (runIn === "sandbox" ? ctx.defaults.scope : "shared");
    const transport = { ...draft, env };
    const minimum = requiredScope({ transport });
    const scope = SCOPE_RANK[requested] >= SCOPE_RANK[minimum] ? requested : minimum;
    const parsed = McpServerConfig.safeParse({
      id,
      displayName: `${name} (${ctx.pluginName})`,
      ...(ctx.description ? { description: ctx.description.slice(0, 1000) } : {}),
      enabled: override.enabled ?? true,
      runIn,
      scope,
      transport,
      source: { kind: "plugin", pluginId: ctx.pluginId, version: ctx.version },
    });
    if (!parsed.success) return { name, requiredSecrets: [], unsupported: parsed.error.issues.map((i) => i.message).join("; "), warnings };
    config = parsed.data;
    const base = command.split("/").pop() ?? command;
    if (runIn === "broker" && BROKER_BANNED_COMMANDS.has(base)) {
      return {
        name,
        config,
        runIn,
        requiredSecrets: requiredSecretNames(config),
        needsPreinstall: [command, ...args].join(" "),
        warnings,
      };
    }
  } else {
    if (typeof cfg.url !== "string") return { name, requiredSecrets: [], unsupported: "http server has no url", warnings };
    const headers = Object.fromEntries(Object.entries(stringRecord(cfg.headers)).map(([k, v]) => [k, conv(v)]));
    // 원격 서버는 sandbox에서 직접 부르지 않고 항상 broker가 프록시한다.
    runIn = "broker";
    const parsed = McpServerConfig.safeParse({
      id,
      displayName: `${name} (${ctx.pluginName})`,
      ...(ctx.description ? { description: ctx.description.slice(0, 1000) } : {}),
      enabled: override.enabled ?? true,
      runIn,
      scope: override.scope ?? "shared",
      transport: { type: "http", url: conv(cfg.url), headers },
      source: { kind: "plugin", pluginId: ctx.pluginId, version: ctx.version },
    });
    if (!parsed.success) return { name, requiredSecrets: [], unsupported: parsed.error.issues.map((i) => i.message).join("; "), warnings };
    config = parsed.data;
  }
  return { name, config, runIn, requiredSecrets: requiredSecretNames(config), warnings };
}

/** `.mcp.json` 내용(`{mcpServers:{…}}` 또는 바로 이름→설정 맵)에서 서버 맵을 꺼낸다. */
export function mcpServerMap(json: unknown): Record<string, unknown> {
  if (!isObject(json)) return {};
  if (isObject(json.mcpServers)) return json.mcpServers;
  return json;
}
