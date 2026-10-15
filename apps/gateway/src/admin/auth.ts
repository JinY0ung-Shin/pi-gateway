import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fastifyCookie } from "@fastify/cookie";
import { bearerToken } from "@pi-gateway/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GatewayConfig } from "../config.js";
import { type Db, migrate } from "../db.js";
import { PlatformError } from "./errors.js";

export const ADMIN_COOKIE = "pi_gw_admin";
export const CSRF_HEADER = "x-admin-request";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 주소별로 이만큼 실패하면 다음 실패에서 잠근다 */
const FREE_ATTEMPTS = 5;
/** 잠금 시간. 마지막 실패 뒤 이만큼 지나면 기록도 잊는다. */
const LOCK_MS = 15 * 60 * 1000;
/** 실패 기록을 남기는 주소 수 상한 (넘으면 가장 오래된 기록부터 지운다) */
const MAX_TRACKED = 10_000;

const MIGRATIONS = [
  `CREATE TABLE admin_sessions (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT
   );`,
] as const;

export type AdminVia = "cookie" | "bearer";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** 길이와 관계없이 일정한 시간에 비교한다 (양쪽을 해시한 뒤 비교). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export const isMutating = (method: string) => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/**
 * 쿠키 직렬화·파싱. @fastify/cookie의 serialize/parse는 plugin을 등록해야 동작하고,
 * gateway의 다른 레인이 같은 plugin을 등록하면 충돌하므로 여기서 직접 처리한다 (서명은 @fastify/cookie의 sign/unsign).
 */
function serializeCookie(name: string, value: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface FailureRecord {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

/**
 * 관리 화면 인증.
 * - 로그인: ADMIN_API_KEY → 서버에 저장되는 세션(12시간). 쿠키에는 서명된 무작위 토큰만 들어간다.
 * - 스크립트: `Authorization: Bearer <ADMIN_API_KEY>`
 * - 쿠키로 들어온 상태 변경 요청은 `X-Admin-Request: 1` 헤더가 있어야 한다 (CSRF 방어).
 * - 로그인과 Bearer 실패는 주소별로 센다. 5번을 넘게 실패하면 15분 동안 잠그고 429와 Retry-After를 준다.
 *   주소는 req.ip이므로 프록시 뒤에서는 TRUST_PROXY를 설정해야 사용자별로 나뉜다.
 * - ADMIN_API_KEY가 없으면 관리 API 전체를 끈다.
 */
export class AdminAuth {
  readonly #db: Db;
  readonly #apiKey: string | undefined;
  readonly #cookieSecret: string;
  /** 주소 → 실패 기록. Map의 삽입 순서를 LRU 순서로 쓴다 (최근 실패가 뒤). */
  readonly #failures = new Map<string, FailureRecord>();
  constructor(db: Db, config: Pick<GatewayConfig, "auth" | "admin">) {
    this.#db = db;
    this.#apiKey = config.auth.adminApiKey;
    this.#cookieSecret = config.admin.cookieSecret || config.auth.adminApiKey || "";
    migrate(db, "admin", MIGRATIONS);
  }

  get enabled(): boolean {
    return Boolean(this.#apiKey) && this.#cookieSecret.length > 0;
  }

  requireEnabled(): void {
    if (!this.enabled) throw new PlatformError(403, "admin_disabled", "the admin API is disabled (ADMIN_API_KEY is not set)");
  }

  /**
   * 요청이 인증됐으면 방법을, 아니면 null을 돌려준다.
   * Bearer 시도는 로그인과 같이 실패를 세고, 잠긴 주소에서는 맞는 키여도 429를 던진다.
   */
  authenticate(req: FastifyRequest): { via: AdminVia; expiresAt?: string } | null {
    if (!this.enabled) return null;
    const token = bearerToken(req.headers.authorization);
    if (token !== null) {
      this.#throwIfLocked(req.ip);
      if (!safeEqual(token, this.#apiKey!)) {
        this.#recordFailure(req.ip);
        return null;
      }
      this.#failures.delete(req.ip);
      return { via: "bearer" };
    }
    const session = this.#session(req);
    return session ? { via: "cookie", expiresAt: session.expiresAt } : null;
  }

  login(req: FastifyRequest, reply: FastifyReply, apiKey: unknown): { expiresAt: string } {
    this.requireEnabled();
    const ip = req.ip;
    const now = Date.now();
    this.#throwIfLocked(ip);
    if (typeof apiKey !== "string" || !safeEqual(apiKey, this.#apiKey!)) {
      this.#recordFailure(ip);
      throw new PlatformError(401, "invalid_credentials", "invalid admin API key");
    }
    this.#failures.delete(ip);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    this.#db.prepare("DELETE FROM admin_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL").run(new Date(now).toISOString());
    this.#db
      .prepare("INSERT INTO admin_sessions (id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, NULL)")
      .run(sha256(token).toString("hex"), new Date(now).toISOString(), expiresAt);
    reply.header(
      "set-cookie",
      serializeCookie(ADMIN_COOKIE, fastifyCookie.sign(token, this.#cookieSecret), {
        maxAgeSeconds: SESSION_TTL_MS / 1000,
        secure: req.protocol === "https",
      }),
    );
    return { expiresAt };
  }

  logout(req: FastifyRequest, reply: FastifyReply): void {
    const token = this.#cookieToken(req);
    if (token) {
      this.#db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), sha256(token).toString("hex"));
    }
    reply.header("set-cookie", serializeCookie(ADMIN_COOKIE, "", { maxAgeSeconds: 0, secure: req.protocol === "https" }));
  }

  #throwIfLocked(ip: string): void {
    const record = this.#failures.get(ip);
    const now = Date.now();
    if (record && record.lockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.lockedUntil - now) / 1000));
      throw new PlatformError(429, "too_many_attempts", `too many failed admin authentication attempts; retry in ${retryAfterSeconds}s`, {
        retryAfterSeconds,
      });
    }
  }

  #recordFailure(ip: string): void {
    const now = Date.now();
    const previous = this.#failures.get(ip);
    const record = previous && now - previous.lastFailureAt <= LOCK_MS ? previous : { failures: 0, lockedUntil: 0, lastFailureAt: now };
    record.failures += 1;
    record.lastFailureAt = now;
    if (record.failures > FREE_ATTEMPTS) record.lockedUntil = now + LOCK_MS;
    // 지웠다가 다시 넣어 가장 최근 항목으로 옮긴다 (Map의 삽입 순서 = 오래된 순)
    this.#failures.delete(ip);
    this.#failures.set(ip, record);
    if (this.#failures.size > MAX_TRACKED) this.#failures.delete(this.#failures.keys().next().value!);
  }

  #cookieToken(req: FastifyRequest): string | null {
    const raw = readCookie(req.headers.cookie, ADMIN_COOKIE);
    if (!raw) return null;
    const result = fastifyCookie.unsign(raw, this.#cookieSecret);
    return result.valid && result.value ? result.value : null;
  }

  #session(req: FastifyRequest): { expiresAt: string } | null {
    const token = this.#cookieToken(req);
    if (!token) return null;
    const row = this.#db
      .prepare("SELECT expires_at, revoked_at FROM admin_sessions WHERE id = ?")
      .get(sha256(token).toString("hex")) as { expires_at: string; revoked_at: string | null } | undefined;
    if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= Date.now()) return null;
    return { expiresAt: row.expires_at };
  }
}

/** `X-Admin-Actor`(percent-encoded)가 있으면 그 이름, 없으면 "admin" */
export function actorOf(req: FastifyRequest): string {
  const raw = req.headers["x-admin-actor"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "admin";
  try {
    return decodeURIComponent(value).trim().slice(0, 120) || "admin";
  } catch {
    return "admin";
  }
}
