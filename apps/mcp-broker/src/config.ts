import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtSecretBytes, readSecret, requireSecret } from "@pi-gateway/shared";

/**
 * mcp-broker 설정. 비밀값은 `NAME_FILE`(Docker secret)로 받는 것을 권장한다.
 * env로 받으면 같은 uid 프로세스가 `/proc/<pid>/environ`으로 읽을 수 있다.
 */
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
  /** 설치된 plugin (읽기 전용). plugin이 제공한 stdio 서버가 여기서 실행된다. */
  pluginsDir: string;
  /** gateway 내부 JWT 검증 키 (AUD_BROKER) */
  jwtSecret: Uint8Array;
  adminToken: string;
  /** 비밀값 암호화 키 (32바이트) */
  kek: Buffer;
  limits: {
    /** 동시에 살아 있는 stdio 프로세스 최대 개수 */
    maxProcesses: number;
    maxProcessesPerServer: number;
    /** http upstream 연결 최대 개수 */
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
  stdio: {
    /** 설정하면 stdio 프로세스마다 이 범위의 uid를 하나씩 배정한다 (CAP_SETUID/SETGID/CHOWN/KILL 필요). */
    uidRange: { start: number; end: number } | null;
    path: string;
    lang: string;
    /** 프로세스별 HOME/TMPDIR을 만드는 위치 */
    workRoot: string;
    maxMessageBytes: number;
    /** 비어 있지 않으면 이 명령(basename 또는 절대 경로)만 실행할 수 있다. */
    commandAllowlist: string[];
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

function parseUidRange(raw: string | undefined): { start: number; end: number } | null {
  if (!raw) return null;
  const m = /^(\d+)-(\d+)$/.exec(raw.trim());
  if (!m) throw new Error("BROKER_STDIO_UID_RANGE must look like 20000-20999");
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 1000 || end < start || end > 4_000_000_000) throw new Error("BROKER_STDIO_UID_RANGE is out of bounds");
  return { start, end };
}

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const jwtSecret = readSecret(env, "BROKER_JWT_SECRET");
  if (!jwtSecret) throw new Error("BROKER_JWT_SECRET (or BROKER_JWT_SECRET_FILE) is required");
  const kek = readSecret(env, "BROKER_KEK");
  if (!kek) throw new Error("BROKER_KEK (or BROKER_KEK_FILE) is required");

  const limits = {
    maxProcesses: int(env, "BROKER_MAX_PROCESSES", 64, 1),
    maxProcessesPerServer: int(env, "BROKER_MAX_PROCESSES_PER_SERVER", 16, 1),
    maxConnections: int(env, "BROKER_MAX_CONNECTIONS", 512, 1),
    idleTtlSeconds: int(env, "BROKER_IDLE_TTL_SECONDS", 300, 5),
    callTimeoutCapSeconds: int(env, "BROKER_CALL_TIMEOUT_CAP_SECONDS", 600, 1),
    connectTimeoutSeconds: int(env, "BROKER_CONNECT_TIMEOUT_SECONDS", 30, 1),
    maxResultBytes: int(env, "BROKER_MAX_RESULT_BYTES", 4 * MiB, 1024),
    maxRequestBodyBytes: int(env, "BROKER_MAX_REQUEST_BODY_BYTES", 4 * MiB, 1024),
    toolsCacheSeconds: int(env, "BROKER_TOOLS_CACHE_SECONDS", 60, 0),
  };

  return {
    host: env.BROKER_HOST ?? "0.0.0.0",
    port: int(env, "BROKER_PORT", 7080),
    adminHost: env.BROKER_ADMIN_HOST ?? env.BROKER_HOST ?? "0.0.0.0",
    adminPort: int(env, "BROKER_ADMIN_PORT", 7081),
    logLevel: env.LOG_LEVEL ?? "info",
    dataDir: env.DATA_DIR ?? "/data",
    pluginsDir: env.PLUGINS_DIR ?? "/opt/plugins",
    jwtSecret: jwtSecretBytes(jwtSecret),
    adminToken: requireSecret(env, "BROKER_ADMIN_TOKEN", 32),
    kek: parseKek(kek),
    limits,
    stdio: {
      uidRange: parseUidRange(env.BROKER_STDIO_UID_RANGE),
      path: env.BROKER_STDIO_PATH ?? "/usr/local/bin:/usr/bin:/bin",
      lang: env.BROKER_STDIO_LANG ?? "C.UTF-8",
      workRoot: env.BROKER_STDIO_WORK_ROOT ?? join(tmpdir(), "mcp-broker"),
      maxMessageBytes: int(env, "BROKER_STDIO_MAX_MESSAGE_BYTES", Math.max(16 * MiB, limits.maxResultBytes * 2), 1024),
      commandAllowlist: (env.BROKER_STDIO_COMMAND_ALLOWLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  };
}

/** broker가 읽는 비밀값 이름 (각각 `NAME_FILE`로 받을 수 있다) */
export const BROKER_SECRET_NAMES = ["BROKER_JWT_SECRET", "BROKER_ADMIN_TOKEN", "BROKER_KEK"] as const;

/** 이 값이 "1"이면 비밀값 파일 권한 문제가 있어도 경고만 하고 시작한다. */
export const ALLOW_INSECURE_SECRET_FILES = "BROKER_ALLOW_INSECURE_SECRET_FILES";

/**
 * 비밀값 파일 권한 검사. group/other가 읽거나 쓸 수 있거나, broker uid 소유가 아니면 문제로 본다.
 * (stdio 자식은 다른 uid로 돌기 때문에, 0444 파일이면 자식이 관리 토큰이나 KEK를 읽을 수 있다.)
 * `problems`는 시작을 막을 문제이고, `warnings`는 환경변수로 받은 비밀값처럼 권장하지 않는 설정이다.
 */
export function auditSecretFiles(
  env: NodeJS.ProcessEnv,
  expectedUid: number = process.getuid?.() ?? 0,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const name of BROKER_SECRET_NAMES) {
    const file = env[`${name}_FILE`];
    if (!file) {
      if (env[name]) warnings.push(`${name} is passed as an environment variable; prefer ${name}_FILE (0400 file)`);
      continue;
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch (error) {
      problems.push(`${name}_FILE (${file}) cannot be read: ${(error as Error).message}`);
      continue;
    }
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      problems.push(`${name}_FILE (${file}) has mode ${mode.toString(8).padStart(4, "0")}; it must not be accessible by group/other (use 0400)`);
    }
    if (st.uid !== expectedUid) {
      problems.push(`${name}_FILE (${file}) is owned by uid ${st.uid}, not the broker uid ${expectedUid}`);
    }
  }
  return { problems, warnings };
}
