import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

/**
 * 발급처(OIDC issuer)가 서명한 access token 검증. 사람이 누구인지와 무엇을 해도 되는지를
 * 이 gateway가 직접 확인한다 — 토큰을 실어 보낸 클라이언트의 말은 믿지 않는다.
 *
 * - 서명: RS256만 받는다. 키는 `jwksUrl`에서 받아 kid로 고른다. 모르는 kid가 오거나 받아 둔 지
 *   10분이 지나면 다시 받되(발급처에서 지운 키를 계속 믿지 않도록), 토큰이 올 때마다 발급처를
 *   두드리지 않게 간격을 둔다. 받기에 실패하면 가진 키로 계속 검증한다.
 * - 클레임: `iss`가 설정한 발급처와 같고, `aud`에 `pi`가 있고, `typ`이 `Bearer`(access token)이고,
 *   만료 전이어야 한다 (시계 오차 30초). 다른 클라이언트용 토큰과 ID token은 통과하지 못한다.
 * - 신원: `sub`가 사용자 id, `realm_access.roles`의 `admin`이 관리자, `groups`의 `teammates`가
 *   승인된 팀원이다 (Keycloak의 클레임 모양).
 *
 * 검증 실패는 이유를 구분하지 않고 null이다. 토큰 내용은 로그에 남기지 않는다.
 */

export interface OidcConfig {
  /** 토큰의 `iss`와 같아야 하는 값 (사용자 브라우저가 보는 발급처 주소) */
  issuer: string;
  /** 서명 키(JWKS)를 받는 주소. 내부망 주소여도 된다. */
  jwksUrl: string;
}

export interface OidcIdentity {
  user: string;
  admin: boolean;
  teammate: boolean;
}

const AUDIENCE = "pi";
const ADMIN_ROLE = "admin";
const TEAM_GROUP = "teammates";
const CLOCK_SKEW_SECONDS = 30;
/** 모르는 kid 때문에 키를 다시 받는 최소 간격 */
const REFETCH_INTERVAL_MS = 60_000;
/** 키가 하나도 없을 때(발급처가 아직 뜨는 중)의 간격 */
const EMPTY_REFETCH_INTERVAL_MS = 5_000;
/** 받아 둔 키를 다시 확인하지 않고 쓰는 시간. 발급처에서 지운 키는 이 시간 안에 여기서도 사라진다. */
const MAX_KEY_AGE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
/** 헤더 길이 한도에 한참 못 미치지만, 해석하기 전에 걸러 둔다 */
const MAX_TOKEN_LENGTH = 16_384;

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** 점 두 개로 나뉜 base64url 세 토막인지. API 키와 JWT를 가르는 데 쓴다. */
export function looksLikeJwt(token: string): boolean {
  if (token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => SEGMENT.test(part));
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export class OidcVerifier {
  readonly #config: OidcConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #fetching: Promise<void> | null = null;
  readonly #warn: (message: string) => void;

  /** `warn`: 발급처에서 키를 받지 못했을 때 한 줄 (받기 간격으로 이미 제한된다; 토큰 내용은 없다). */
  constructor(config: OidcConfig, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, warn: (message: string) => void = () => {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#warn = warn;
  }

  /** 유효한 토큰이면 신원을, 아니면 null을 돌려준다. 던지지 않는다. */
  async verify(token: string): Promise<OidcIdentity | null> {
    if (!looksLikeJwt(token)) return null;
    const [headerPart, payloadPart, signaturePart] = token.split(".") as [string, string, string];
    const header = parseSegment(headerPart);
    // alg는 토큰이 고르는 것이 아니다: RS256 하나만 받는다 (none, HS256으로 바꿔 넣는 공격을 막는다).
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return null;
    const key = await this.#keyFor(header.kid);
    if (!key) return null;
    let signed = false;
    try {
      signed = verifySignature("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, "base64url"));
    } catch {
      return null;
    }
    if (!signed) return null;

    const payload = parseSegment(payloadPart);
    if (!payload) return null;
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (payload.iss !== this.#config.issuer) return null;
    // access token만 받는다 (Keycloak은 access token에 typ: "Bearer", ID token에 "ID"를 넣는다).
    if (payload.typ !== "Bearer") return null;
    const audience = typeof payload.aud === "string" ? [payload.aud] : stringList(payload.aud);
    if (!audience.includes(AUDIENCE)) return null;
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return null;
    if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;

    const realmAccess = payload.realm_access;
    const roles = typeof realmAccess === "object" && realmAccess !== null ? stringList((realmAccess as { roles?: unknown }).roles) : [];
    return { user: payload.sub, admin: roles.includes(ADMIN_ROLE), teammate: stringList(payload.groups).includes(TEAM_GROUP) };
  }

  async #keyFor(kid: string): Promise<KeyObject | null> {
    const age = this.#now() - this.#fetchedAt;
    const known = this.#keys.get(kid);
    if (known && age < MAX_KEY_AGE_MS) return known;
    // 처음이거나, 모르는 kid거나, 받아 둔 지 오래됐다. 간격 안에서는 다시 받지 않는다 (아무 kid나 보내 발급처를 두드릴 수 없게).
    const interval = this.#keys.size === 0 ? EMPTY_REFETCH_INTERVAL_MS : REFETCH_INTERVAL_MS;
    if (this.#fetchedAt === 0 || age >= interval) await this.#refresh();
    return this.#keys.get(kid) ?? null;
  }

  /** 동시에 온 요청은 한 번의 받기를 함께 기다린다. 실패하면 가진 키를 그대로 둔다. */
  #refresh(): Promise<void> {
    this.#fetching ??= (async () => {
      try {
        const response = await this.#fetch(this.#config.jwksUrl, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          this.#warn(`OIDC signing keys could not be fetched (HTTP ${response.status})`);
          return;
        }
        const body = (await response.json()) as { keys?: unknown };
        const keys = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
          if (typeof jwk !== "object" || jwk === null) continue;
          const { kid, kty, use } = jwk as { kid?: unknown; kty?: unknown; use?: unknown };
          // 서명용 RSA 키만 쓴다 (Keycloak은 암호화용 키도 함께 내놓는다).
          if (typeof kid !== "string" || kty !== "RSA" || (use !== undefined && use !== "sig")) continue;
          try {
            keys.set(kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
          } catch {
            // 해석할 수 없는 키는 건너뛴다
          }
        }
        if (keys.size > 0) this.#keys = keys;
        else this.#warn("OIDC signing keys could not be fetched (the answer holds no RSA signing key)");
      } catch (error) {
        // 발급처에 닿지 못했다: 가진 키로 계속 검증하고, 간격이 지나면 다시 시도한다
        this.#warn(`OIDC signing keys could not be fetched (${error instanceof Error ? error.name : "error"})`);
      } finally {
        this.#fetchedAt = this.#now();
        this.#fetching = null;
      }
    })();
    return this.#fetching;
  }
}
