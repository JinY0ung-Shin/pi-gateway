import { createHash } from "node:crypto";

/** 사용자 id(= principal) 형식 */
export const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export function isValidUserId(id: string): boolean {
  return USER_ID_PATTERN.test(id);
}

export function isValidPrincipal(principal: string): boolean {
  return isValidUserId(principal);
}

/**
 * principal → 컨테이너 이름과 디렉토리 이름에 쓰는 키.
 * 원래 사용자 id를 호스트 경로나 `docker ps`에 드러내지 않는다.
 */
export function userKey(principal: string): string {
  return "u-" + createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24);
}
