import { jwtSecretBytes, readSecret, requireSecret } from "@pi-gateway/shared";

/** mcp-broker 설정. 모든 값은 환경변수에서 읽는다 (비밀값은 `NAME_FILE`도 지원). */
export interface BrokerConfig {
  host: string;
  /** 데이터 평면 (gateway가 MCP를 호출하는 포트) */
  port: number;
  adminHost: string;
  /** 관리 평면 */
  adminPort: number;
  logLevel: string;
  /** broker.db 위치 */
  dataDir: string;
  /** gateway 내부 JWT 검증 키 (AUD_BROKER) */
  jwtSecret: Uint8Array;
  adminToken: string;
  /** 비밀값 암호화 키 (32바이트) */
  kek: Buffer;
  limits: {
    /** upstream 연결 최대 개수 */
    maxConnections: number;
    idleTtlSeconds: number;
    /** 서버별 timeoutSec의 상한. gateway의 도구 timeout보다 짧아야 한다. */
    callTimeoutCapSeconds: number;
    connectTimeoutSeconds: number;
    /** 도구 결과(JSON 직렬화 기준) 최대 크기 */
    maxResultBytes: number;
    maxRequestBodyBytes: number;
    toolsCacheSeconds: number;
  };
}

const MiB = 1024 * 1024;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function parseKek(value: string): Buffer {
  const bytes = Buffer.from(value.trim(), "base64");
  if (bytes.length !== 32) throw new Error("BROKER_KEK must be 32 bytes encoded as base64 (openssl rand -base64 32)");
  return bytes;
}

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const jwtSecret = readSecret(env, "BROKER_JWT_SECRET");
  if (!jwtSecret) throw new Error("BROKER_JWT_SECRET (or BROKER_JWT_SECRET_FILE) is required");
  const kek = readSecret(env, "BROKER_KEK");
  if (!kek) throw new Error("BROKER_KEK (or BROKER_KEK_FILE) is required");

  return {
    host: env.BROKER_HOST ?? "0.0.0.0",
    port: int(env, "BROKER_PORT", 7080),
    adminHost: env.BROKER_ADMIN_HOST ?? env.BROKER_HOST ?? "0.0.0.0",
    adminPort: int(env, "BROKER_ADMIN_PORT", 7081),
    logLevel: env.LOG_LEVEL ?? "info",
    dataDir: env.DATA_DIR ?? "/data",
    jwtSecret: jwtSecretBytes(jwtSecret),
    adminToken: requireSecret(env, "BROKER_ADMIN_TOKEN", 32),
    kek: parseKek(kek),
    limits: {
      maxConnections: int(env, "BROKER_MAX_CONNECTIONS", 512, 1),
      idleTtlSeconds: int(env, "BROKER_IDLE_TTL_SECONDS", 300, 5),
      callTimeoutCapSeconds: int(env, "BROKER_CALL_TIMEOUT_CAP_SECONDS", 600, 1),
      connectTimeoutSeconds: int(env, "BROKER_CONNECT_TIMEOUT_SECONDS", 30, 1),
      maxResultBytes: int(env, "BROKER_MAX_RESULT_BYTES", 4 * MiB, 1024),
      maxRequestBodyBytes: int(env, "BROKER_MAX_REQUEST_BODY_BYTES", 4 * MiB, 1024),
      toolsCacheSeconds: int(env, "BROKER_TOOLS_CACHE_SECONDS", 60, 0),
    },
  };
}
