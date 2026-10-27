import {
  atLeastScope,
  type McpScope,
  type McpServerConfig,
  type RequestContext,
  renderTemplate,
  requiredHeaderNames,
  requiredScope,
  type TemplateValues,
} from "@pi-gateway/shared";

/** 검증된 JWT에서만 만든다. 요청 본문이나 도구 인자에서 오지 않는다. */
export interface Identity {
  sub: string;
  sid?: string;
  ctx?: RequestContext;
}

/** 원격 MCP 서버에 붙을 주소와 헤더 (자리표시자를 채운 값) */
export interface RenderedTransport {
  url: string;
  headers: Record<string, string>;
}

export interface RenderResult {
  transport: RenderedTransport;
  /** 이 연결에 들어간 사용자 헤더 값. 결과를 가릴 때 쓴다 (비밀키 값은 #prepare가 모두 넣는다). */
  headerCredentials: string[];
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

/**
 * 실제로 적용할 scope. 설정값보다 템플릿이 요구하는 scope가 넓으면 그쪽을 쓴다.
 * (http 서버는 scope 검증 규칙이 없어서, 사용자별 헤더를 쓰면서 shared로 설정될 수 있다.)
 */
export function effectiveScope(config: McpServerConfig): McpScope {
  return atLeastScope(config.scope, requiredScope(config));
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
  const values: TemplateValues = { user: identity.sub, secret: (name) => secrets.get(name) };
  if (identity.sid !== undefined) values.session = identity.sid;
  if (identity.ctx?.headers) values.headers = identity.ctx.headers;
  if (identity.ctx?.metadata) values.metadata = identity.ctx.metadata;

  const headerCredentials = requiredHeaderNames(config).flatMap((name) => identity.ctx?.headers?.[name] || []);
  const render = (input: string): string => renderTemplate(input, values);

  const t = config.transport;
  if (t.type !== "http") throw new ConfigError("broker servers must use the http transport");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers)) headers[k] = render(v);
  return { transport: { url: render(t.url), headers }, headerCredentials };
}
