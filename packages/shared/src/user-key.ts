import { createHash } from "node:crypto";

/** 실제 사용자 id 형식. 첫 글자가 영숫자라서 익명 principal(`_anon-`)과 겹치지 않는다. */
export const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export const ANON_PREFIX = "_anon-";
const ANON_PATTERN = /^_anon-[0-9a-f-]{36}$/;

export function isValidUserId(id: string): boolean {
  return USER_ID_PATTERN.test(id);
}

/** 사용자 없이 들어온 세션의 principal. 세션이 끝나면 sandbox와 workspace를 지운다. */
export function anonPrincipal(sessionId: string): string {
  return `${ANON_PREFIX}${sessionId}`;
}

export function isAnonPrincipal(principal: string): boolean {
  return ANON_PATTERN.test(principal);
}

export function isValidPrincipal(principal: string): boolean {
  return isValidUserId(principal) || isAnonPrincipal(principal);
}

/**
 * principal → 컨테이너 이름과 디렉토리 이름에 쓰는 키.
 * 원래 사용자 id를 호스트 경로나 `docker ps`에 드러내지 않는다.
 */
export function userKey(principal: string): string {
  return "u-" + createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24);
}
