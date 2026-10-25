import { readFileSync } from "node:fs";

/**
 * 비밀값을 읽는다. `NAME_FILE`(Docker secret 파일 경로)이 있으면 그 파일 내용을,
 * 없으면 `NAME` 환경변수 값을 쓴다. 끝의 개행은 제거한다.
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** 내부 JWT용 HMAC 키. 32바이트 이상이어야 한다. */
export function jwtSecretBytes(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 32) throw new Error("internal JWT secret must be at least 32 bytes");
  return bytes;
}
