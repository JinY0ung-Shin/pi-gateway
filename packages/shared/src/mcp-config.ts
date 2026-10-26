import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * MCP 서버 설정 — gateway(관리 UI, sandbox 실행)와 mcp-broker(broker 프록시)가 함께 쓰는 스키마.
 *
 * runIn
 * - "broker": 비밀키가 필요한 원격 HTTP 서버. broker DB에 저장되고 broker가 비밀키를 붙여 프록시한다.
 * - "sandbox": 비밀키가 없고 workspace 파일이 필요한 서버. gateway DB에 저장되고,
 *   사용자 sandbox 컨테이너 안에서 stdio로 실행한다.
 *
 * 템플릿 자리표시자 (transport의 문자열 값 안에서만 쓴다):
 *   {{secret:NAME}}      broker 비밀 저장소 값              — broker만
 *   {{ctx.header:NAME}}  클라이언트가 보낸 헤더(allowlist)    — broker만 (사용자 토큰이 agent에게 보이면 안 되므로)
 *   {{user}}             principal
 *   {{session}}          gateway 세션 id
 *   {{metadata:KEY}}     요청 metadata(allowlist)
 */

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const McpRunIn = z.enum(["broker", "sandbox"]);
export type McpRunIn = z.infer<typeof McpRunIn>;

/** stdio 프로세스(또는 http 연결)를 누구와 공유하는가 */
export const McpScope = z.enum(["shared", "per-user", "per-session"]);
export type McpScope = z.infer<typeof McpScope>;

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const McpStdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(envName, z.string()).default({}),
  cwd: z.string().optional(),
});

/** Streamable HTTP. SSE 전용(구형) 서버는 지원하지 않는다. */
export const McpHttpTransport = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const McpTransportConfig = z.discriminatedUnion("type", [McpStdioTransport, McpHttpTransport]);
export type McpTransportConfig = z.infer<typeof McpTransportConfig>;

export const McpServerSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("plugin"), pluginId: z.string(), version: z.string() }),
]);
export type McpServerSource = z.infer<typeof McpServerSource>;

export const McpServerConfigBase = z.object({
  id: z.string().regex(MCP_SERVER_ID_PATTERN),
  displayName: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  runIn: McpRunIn,
  scope: McpScope.default("shared"),
  transport: McpTransportConfig,
  /** 지정하면 이 도구만 노출한다 (MCP 원래 도구 이름) */
  toolAllow: z.array(z.string()).optional(),
  toolDeny: z.array(z.string()).optional(),
  timeoutSec: z.number().int().min(1).max(3600).default(120),
  source: McpServerSource.default({ kind: "manual" }),
});

export const McpServerConfig = McpServerConfigBase.superRefine((config, ctx) => {
  for (const message of validateMcpServerConfig(config)) ctx.addIssue({ code: "custom", message });
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;
export type McpServerConfigInput = z.input<typeof McpServerConfig>;

// ── 템플릿 ──────────────────────────────────────────────────────────

export type TemplateRef =
  | { kind: "secret"; name: string }
  | { kind: "header"; name: string }
  | { kind: "user" }
  | { kind: "session" }
  | { kind: "metadata"; key: string };

const ANY_TEMPLATE = /\{\{([^{}]*)\}\}/g;
const SECRET_REF = /^secret:([A-Za-z0-9_.-]{1,64})$/;
const HEADER_REF = /^ctx\.header:([A-Za-z0-9-]{1,128})$/;
const METADATA_REF = /^metadata:([A-Za-z0-9_.-]{1,128})$/;

function parseRef(body: string): TemplateRef | null {
  const ref = body.trim();
  if (ref === "user") return { kind: "user" };
  if (ref === "session") return { kind: "session" };
  let m = SECRET_REF.exec(ref);
  if (m?.[1]) return { kind: "secret", name: m[1] };
  m = HEADER_REF.exec(ref);
  if (m?.[1]) return { kind: "header", name: m[1].toLowerCase() };
  m = METADATA_REF.exec(ref);
  if (m?.[1]) return { kind: "metadata", key: m[1] };
  return null;
}

/** 문자열 안의 자리표시자. 알 수 없는 자리표시자는 `unknown`에 담는다. */
export function findTemplateRefs(value: string): { refs: TemplateRef[]; unknown: string[] } {
  const refs: TemplateRef[] = [];
  const unknown: string[] = [];
  for (const match of value.matchAll(ANY_TEMPLATE)) {
    const ref = parseRef(match[1] ?? "");
    if (ref) refs.push(ref);
    else unknown.push(match[0]);
  }
  return { refs, unknown };
}

/** transport 안의 모든 템플릿 대상 문자열 */
export function transportStrings(transport: McpTransportConfig): string[] {
  if (transport.type === "stdio") {
    return [transport.command, ...transport.args, ...Object.values(transport.env), ...(transport.cwd ? [transport.cwd] : [])];
  }
  return [transport.url, ...Object.values(transport.headers)];
}

export function collectTemplateRefs(config: Pick<McpServerConfig, "transport">): { refs: TemplateRef[]; unknown: string[] } {
  const refs: TemplateRef[] = [];
  const unknown: string[] = [];
  for (const s of transportStrings(config.transport)) {
    const found = findTemplateRefs(s);
    refs.push(...found.refs);
    unknown.push(...found.unknown);
  }
  return { refs, unknown };
}

export function requiredSecretNames(config: Pick<McpServerConfig, "transport">): string[] {
  const names = new Set<string>();
  for (const ref of collectTemplateRefs(config).refs) if (ref.kind === "secret") names.add(ref.name);
  return [...names].sort();
}

const SCOPE_RANK: Record<McpScope, number> = { shared: 0, "per-user": 1, "per-session": 2 };

/** 템플릿이 요구하는 최소 scope: {{session}}·{{metadata}}는 per-session, {{user}}·{{ctx.header}}는 per-user */
export function requiredScope(config: Pick<McpServerConfig, "transport">): McpScope {
  const { refs } = collectTemplateRefs(config);
  if (refs.some((r) => r.kind === "session" || r.kind === "metadata")) return "per-session";
  if (refs.some((r) => r.kind === "user" || r.kind === "header")) return "per-user";
  return "shared";
}

/** scope가 min보다 좁으면 min으로 올린다 */
export function atLeastScope(scope: McpScope, min: McpScope): McpScope {
  return SCOPE_RANK[scope] >= SCOPE_RANK[min] ? scope : min;
}

/**
 * 비밀값이 어디로 가는지를 나타내는 정규화된 문자열. broker는 이 값이 바뀌면 저장된 비밀값을 지운다
 * (관리 API를 부를 수 있는 쪽이 url이나 헤더를 바꿔 기존 비밀값을 빼내지 못하게).
 * url의 origin, 헤더 전체, url 안에서 쓰는 비밀키 이름으로 정한다.
 */
export function transportTarget(config: Pick<McpServerConfig, "transport">): string {
  const t = config.transport;
  // broker 서버는 http만 쓴다 (스키마가 검사한다)
  if (t.type !== "http") return JSON.stringify(t);
  let origin: string;
  try {
    // 자리표시자가 host에 들어 있으면 그 자체가 행선지를 바꿀 수 있으므로 문자 그대로 비교한다.
    origin = /\{\{/.test(t.url.split("/").slice(0, 3).join("/")) ? t.url : new URL(t.url).origin;
  } catch {
    origin = t.url;
  }
  const headers = Object.entries(t.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const urlSecrets = collectTemplateRefs({ transport: { ...t, headers: {} } })
    .refs.flatMap((r) => (r.kind === "secret" ? [r.name] : []))
    .sort();
  return JSON.stringify({ type: "http", origin, headers, urlSecrets });
}

/**
 * 스키마 밖의 규칙 검사. 오류 메시지 목록을 돌려준다 (비어 있으면 통과).
 * - sandbox 서버는 stdio, broker 서버는 http만 쓴다.
 * - sandbox 실행 서버에는 {{secret:…}}, {{ctx.header:…}}를 쓸 수 없다.
 * - stdio 서버는 env·args가 프로세스 시작 시 고정되므로,
 *   {{user}}/{{ctx.header}}를 쓰면 scope가 per-user 이상, {{session}}/{{metadata}}를 쓰면 per-session이어야 한다.
 */
export function validateMcpServerConfig(config: z.infer<typeof McpServerConfigBase>): string[] {
  const errors: string[] = [];
  const { refs, unknown } = collectTemplateRefs(config);
  for (const u of unknown) errors.push(`unknown template placeholder ${u}`);
  if (config.runIn === "sandbox") {
    if (refs.some((r) => r.kind === "secret")) errors.push("sandbox servers must not use {{secret:...}}");
    if (refs.some((r) => r.kind === "header")) errors.push("sandbox servers must not use {{ctx.header:...}}");
    if (config.transport.type !== "stdio") errors.push("sandbox servers must use the stdio transport");
  } else if (config.transport.type !== "http") {
    errors.push("broker servers must use the http transport");
  }
  if (config.transport.type === "stdio") {
    const min = requiredScope(config);
    if (atLeastScope(config.scope, min) !== config.scope) {
      errors.push(
        min === "per-session"
          ? "stdio servers using {{session}} or {{metadata:...}} must have scope per-session"
          : "stdio servers using {{user}} or {{ctx.header:...}} must have scope per-user or per-session",
      );
    }
  }
  return errors;
}

export interface TemplateValues {
  user: string;
  session?: string;
  /** 소문자 이름 */
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  secret?: (name: string) => string | undefined;
}

/** 자리표시자를 값으로 바꾼다. 값이 없는 자리표시자는 빈 문자열로 바꾸고 `missing`에 담는다. */
export function renderTemplate(value: string, values: TemplateValues): { value: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = value.replace(ANY_TEMPLATE, (whole, body: string) => {
    const ref = parseRef(body);
    let out: string | undefined;
    switch (ref?.kind) {
      case "user":
        out = values.user;
        break;
      case "session":
        out = values.session;
        break;
      case "secret":
        out = values.secret?.(ref.name);
        break;
      case "header":
        out = values.headers?.[ref.name];
        break;
      case "metadata":
        out = values.metadata?.[ref.key];
        break;
      default:
        out = undefined;
    }
    if (out === undefined) {
      missing.push(whole);
      return "";
    }
    return out;
  });
  return { value: rendered, missing };
}

// ── 리터럴 자격증명 검사 ────────────────────────────────────────────

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"]);
const CREDENTIAL_ENV = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)$/i;
const CREDENTIAL_QUERY = new Set(["token", "access_token", "api_key", "apikey", "key", "secret", "password", "auth"]);
const HAS_CREDENTIAL_REF = /\{\{\s*(secret:|ctx\.header:)/;

/**
 * 자격증명 자리(인증 헤더, 이름이 TOKEN·SECRET·API_KEY 등으로 끝나는 env, URL의 인증 query·user:pass)에
 * 리터럴 값이 있으면 문제 목록을 돌려준다. 그 자리에는 {{secret:…}}·{{ctx.header:…}}만 쓸 수 있다.
 * broker는 이것으로 broker 서버를 검사하고, gateway는 sandbox 서버(값이 agent env에 들어간다)를 검사한다.
 */
export function findLiteralCredentials(config: Pick<McpServerConfig, "transport">): string[] {
  const problems: string[] = [];
  const literal = (value: string) => value.trim() !== "" && !HAS_CREDENTIAL_REF.test(value);
  const t = config.transport;
  if (t.type === "http") {
    for (const [name, value] of Object.entries(t.headers)) {
      if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && literal(value)) {
        problems.push(`header '${name}' holds a literal credential; use {{secret:NAME}}`);
      }
    }
    try {
      const url = new URL(t.url);
      if (url.username || url.password) problems.push("url must not embed credentials; use a header with {{secret:NAME}}");
      for (const [name, value] of url.searchParams) {
        if (CREDENTIAL_QUERY.has(name.toLowerCase()) && literal(value)) {
          problems.push(`url query parameter '${name}' holds a literal credential; use {{secret:NAME}}`);
        }
      }
    } catch {
      // URL 형식은 스키마가 검사한다. 템플릿이 들어 있으면 여기서 파싱이 안 될 수 있다.
    }
  } else {
    for (const [name, value] of Object.entries(t.env)) {
      if (CREDENTIAL_ENV.test(name) && literal(value)) {
        problems.push(`env '${name}' holds a literal credential; use {{secret:NAME}}`);
      }
    }
  }
  return problems;
}

// ── 도구 이름 ────────────────────────────────────────────────────────

const MAX_TOOL_NAME = 64;

/** 모델에 노출하는 도구 이름: `mcp__<serverId>__<tool>`. 함수 이름 규칙([A-Za-z0-9_-], 64자)에 맞춘다. */
export function mcpToolName(serverId: string, tool: string): string {
  const safeTool = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `mcp__${serverId}__${safeTool}`;
  if (name.length <= MAX_TOOL_NAME) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

export function isToolAllowed(config: Pick<McpServerConfig, "toolAllow" | "toolDeny">, tool: string): boolean {
  if (config.toolDeny?.includes(tool)) return false;
  if (config.toolAllow && !config.toolAllow.includes(tool)) return false;
  return true;
}
