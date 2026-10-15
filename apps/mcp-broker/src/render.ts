import { basename } from "node:path";
import {
  collectTemplateRefs,
  type McpScope,
  type McpServerConfig,
  type RequestContext,
  renderTemplate,
  type TemplateValues,
} from "@pi-gateway/shared";

/** 검증된 JWT에서만 만든다. 요청 본문이나 도구 인자에서 오지 않는다. */
export interface Identity {
  sub: string;
  sid?: string;
  ctx?: RequestContext;
}

export type RenderedTransport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers: Record<string, string> };

export interface RenderResult {
  transport: RenderedTransport;
  /** 이 연결에 들어간 자격증명 값 (비밀키와 전달된 사용자 헤더). 결과를 가릴 때 쓴다. */
  credentials: string[];
  /** 값이 없는 비밀키 자리표시자 이름 (있으면 연결하면 안 된다) */
  missingSecrets: string[];
  /** 값이 없어 빈 문자열이 된 그 밖의 자리표시자 */
  missingOptional: string[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export class MissingSessionError extends Error {
  override name = "MissingSessionError";
  constructor() {
    super("per-session MCP servers require a session id in the token");
  }
}

const SCOPE_RANK: Record<McpScope, number> = { shared: 0, "per-user": 1, "per-session": 2 };

/**
 * 실제로 적용할 scope. 설정값보다 템플릿이 요구하는 scope가 넓으면 그쪽을 쓴다.
 * (http 서버는 scope 검증 규칙이 없어서, 사용자별 헤더를 쓰면서 shared로 설정될 수 있다.)
 */
export function effectiveScope(config: McpServerConfig): McpScope {
  const { refs } = collectTemplateRefs(config);
  let required: McpScope = "shared";
  if (refs.some((r) => r.kind === "user" || r.kind === "header")) required = "per-user";
  if (refs.some((r) => r.kind === "session" || r.kind === "metadata")) required = "per-session";
  return SCOPE_RANK[required] > SCOPE_RANK[config.scope] ? required : config.scope;
}

export function scopeKey(scope: McpScope, identity: Identity): string {
  switch (scope) {
    case "shared":
      return "shared";
    case "per-user":
      return `u:${identity.sub}`;
    case "per-session":
      if (!identity.sid) throw new MissingSessionError();
      return `s:${identity.sub}:${identity.sid}`;
  }
}

export function renderTransport(config: McpServerConfig, identity: Identity, secrets: Map<string, string>): RenderResult {
  const credentials = new Set<string>();
  const missingSecrets = new Set<string>();
  const missingOptional = new Set<string>();
  const values: TemplateValues = {
    user: identity.sub,
    secret: (name) => {
      const value = secrets.get(name);
      if (value === undefined) missingSecrets.add(name);
      else credentials.add(value);
      return value;
    },
  };
  if (identity.sid !== undefined) values.session = identity.sid;
  if (identity.ctx?.headers) values.headers = identity.ctx.headers;
  if (identity.ctx?.metadata) values.metadata = identity.ctx.metadata;

  for (const ref of collectTemplateRefs(config).refs) {
    if (ref.kind === "header") {
      const value = identity.ctx?.headers?.[ref.name];
      if (value) credentials.add(value);
    }
    if (ref.kind === "plugin_root") throw new ConfigError("{{plugin_root}} must be resolved when the plugin is installed");
  }

  const render = (input: string): string => {
    const out = renderTemplate(input, values);
    for (const m of out.missing) if (!m.includes("secret:")) missingOptional.add(m);
    return out.value;
  };

  const t = config.transport;
  let transport: RenderedTransport;
  if (t.type === "stdio") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.env)) env[k] = render(v);
    transport = { type: "stdio", command: render(t.command), args: t.args.map(render), env };
    if (t.cwd) transport.cwd = render(t.cwd);
  } else {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.headers)) headers[k] = render(v);
    transport = { type: "http", url: render(t.url), headers };
  }
  return {
    transport,
    credentials: [...credentials],
    missingSecrets: [...missingSecrets].sort(),
    missingOptional: [...missingOptional],
  };
}

// ── 관리 API 입력 검사 ────────────────────────────────────────────────

/** 실행 시 패키지를 내려받는 명령. 이미지에 미리 설치한 명령만 쓴다. */
const DOWNLOADING_COMMANDS = new Set(["npx", "uvx", "bunx", "pnpx", "pipx", "npm", "pnpm", "yarn"]);

export function checkStdioCommand(command: string, allowlist: readonly string[]): string | null {
  const name = basename(command);
  if (DOWNLOADING_COMMANDS.has(name)) {
    return `command '${name}' downloads packages at runtime; pre-install the server in the broker image and run it directly`;
  }
  if (allowlist.length > 0 && !allowlist.includes(command) && !allowlist.includes(name)) {
    return `command '${command}' is not in BROKER_STDIO_COMMAND_ALLOWLIST`;
  }
  return null;
}
