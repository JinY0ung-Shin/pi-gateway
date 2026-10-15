import { createHash, timingSafeEqual } from "node:crypto";
import { bearerToken } from "@pi-gateway/shared";
import type { GatewayConfig } from "../config.js";
import { unauthorized } from "../errors.js";

/**
 * `/v1/*` 인증 (oh-my-gateway와 같은 규칙).
 * - USER_API_KEYS의 키: 키가 principal을 정한다 (body.user는 무시하고 덮어쓴다).
 * - API_KEY(서비스 키): body.user를 그대로 믿는다 (BFF 패턴).
 * - 키가 하나도 없고 AUTH_DISABLED=1: 인증 없이 허용 (개발용).
 * 키 비교는 해시 후 상수 시간으로 한다.
 */

export type AuthResult = { kind: "user"; user: string } | { kind: "service" } | { kind: "open" };

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export class Authenticator {
  private readonly userByKeyHash = new Map<string, string>();
  private readonly serviceKeyHash: Buffer | null;
  private readonly open: boolean;

  constructor(auth: GatewayConfig["auth"]) {
    for (const [user, key] of Object.entries(auth.userApiKeys)) this.userByKeyHash.set(digest(key).toString("hex"), user);
    this.serviceKeyHash = auth.apiKey ? digest(auth.apiKey) : null;
    this.open = auth.disabled && !auth.apiKey && this.userByKeyHash.size === 0;
  }

  authenticate(authorization: string | undefined): AuthResult {
    if (this.open) return { kind: "open" };
    const token = bearerToken(authorization);
    if (!token) throw unauthorized("Missing API key");
    const hash = digest(token);
    if (this.serviceKeyHash && timingSafeEqual(hash, this.serviceKeyHash)) return { kind: "service" };
    const user = this.userByKeyHash.get(hash.toString("hex"));
    if (user) return { kind: "user", user };
    throw unauthorized("Invalid API key");
  }
}
