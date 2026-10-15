import { jwtVerify, SignJWT } from "jose";

/**
 * gateway → sandboxd / mcp-broker 호출에 쓰는 짧은 수명의 HS256 JWT.
 * audience마다 다른 비밀키를 쓰므로, 한쪽 비밀키로 다른 쪽 토큰을 만들 수 없다.
 */
export const AUD_SANDBOXD = "pi-gateway:sandboxd";
export const AUD_BROKER = "pi-gateway:mcp-broker";
const ISSUER = "pi-gateway:gateway";
const MAX_TTL_SECONDS = 300;

export interface RequestContext {
  /** `MCP_FORWARD_HEADERS`로 허용된 클라이언트 요청 헤더. 이름은 소문자. */
  headers?: Record<string, string>;
  /** `MCP_METADATA_KEYS`로 허용된 요청 metadata. */
  metadata?: Record<string, string>;
}

export interface InternalClaims {
  /** principal (사용자 id 또는 `_anon-<sessionId>`) */
  sub: string;
  /** gateway 세션 id */
  sid?: string;
  ctx?: RequestContext;
}

export interface VerifiedInternalClaims extends InternalClaims {
  iat: number;
  exp: number;
}

export async function signInternalToken(
  secret: Uint8Array,
  audience: string,
  claims: InternalClaims,
  ttlSeconds = 120,
): Promise<string> {
  if (ttlSeconds > MAX_TTL_SECONDS) throw new Error(`internal token TTL must be <= ${MAX_TTL_SECONDS}s`);
  const payload: Record<string, unknown> = {};
  if (claims.sid !== undefined) payload.sid = claims.sid;
  if (claims.ctx !== undefined) payload.ctx = claims.ctx;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid ${field}`);
  for (const v of Object.values(value)) if (typeof v !== "string") throw new Error(`invalid ${field}`);
  return value as Record<string, string>;
}

export async function verifyInternalToken(
  secret: Uint8Array,
  audience: string,
  token: string,
): Promise<VerifiedInternalClaims> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience,
    clockTolerance: 5,
    maxTokenAge: `${MAX_TTL_SECONDS}s`,
  });
  if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("token has no subject");
  if (payload.sid !== undefined && typeof payload.sid !== "string") throw new Error("invalid sid");
  let ctx: RequestContext | undefined;
  if (payload.ctx !== undefined) {
    if (typeof payload.ctx !== "object" || payload.ctx === null) throw new Error("invalid ctx");
    const raw = payload.ctx as Record<string, unknown>;
    ctx = {};
    const headers = stringRecord(raw.headers, "ctx.headers");
    const metadata = stringRecord(raw.metadata, "ctx.metadata");
    if (headers) ctx.headers = headers;
    if (metadata) ctx.metadata = metadata;
  }
  const result: VerifiedInternalClaims = { sub: payload.sub, iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  if (typeof payload.sid === "string") result.sid = payload.sid;
  if (ctx) result.ctx = ctx;
  return result;
}

/** `Authorization: Bearer <token>` 헤더에서 토큰만 꺼낸다. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}
