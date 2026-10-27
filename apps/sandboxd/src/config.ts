import { isAbsolute } from "node:path";
import { jwtSecretBytes, readSecret } from "@pi-gateway/shared";

export interface SandboxdConfig {
  port: number;
  logLevel: string;
  jwtSecret: Uint8Array;
  image: string;
  /**
   * egress 프록시의 unix socket이 있는 Docker 볼륨 (docker-compose.yml의 proxy-sock과 같은 이름).
   * sandbox는 network_mode none이고, 이 볼륨을 /run/pi-proxy에 읽기 전용으로 mount해서 프록시로만 나간다.
   */
  proxyVolume: string;
  /** 비우면 Docker 기본(runc). gVisor면 "runsc". */
  runtime: string | undefined;
  /** sandboxd 안에서 보이는 workspace 루트 (사용자 디렉토리 생성·삭제용) */
  workspacesDir: string;
  /** Docker 호스트에서의 같은 디렉토리 (bind mount source) */
  workspacesHostDir: string;
  /** Docker 호스트의 plugin 디렉토리 (sandbox의 /opt/plugins, 읽기 전용) */
  pluginsHostDir: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  tmpSize: string;
  shmSizeBytes: number;
  idleSeconds: number;
  reapIntervalMs: number;
  /** 컨테이너 이름 접두사와 label 값. 테스트는 다른 값을 써서 운영 컨테이너를 건드리지 않는다. */
  containerPrefix: string;
  instance: string;
  /** fs 도우미 한 번의 최대 실행 시간 */
  fsTimeoutSeconds: number;
}

const UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** "512m", "1g", "1048576" → 바이트 */
export function parseBytes(name: string, raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg]?)i?b?$/i.exec(raw.trim());
  if (!m) throw new Error(`${name} must look like 512m or 1g`);
  const value = Number(m[1]) * UNITS[(m[2] ?? "").toLowerCase()]!;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function absolute(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value.replace(/\/+$/, "") || "/";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SandboxdConfig {
  const secret = readSecret(env, "SANDBOXD_JWT_SECRET");
  if (!secret) throw new Error("SANDBOXD_JWT_SECRET (or _FILE) is required");

  const workspacesDir = absolute("WORKSPACES_DIR", env.WORKSPACES_DIR);
  const workspacesHostDir = absolute("WORKSPACES_HOST_DIR", env.WORKSPACES_HOST_DIR ?? workspacesDir);
  const pluginsHostDir = absolute("PLUGINS_HOST_DIR", env.PLUGINS_HOST_DIR);

  const cpus = Number(env.SANDBOX_CPUS ?? "1");
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) throw new Error("SANDBOX_CPUS must be between 0 and 64");

  const idleSeconds = int(env, "SANDBOX_IDLE_SECONDS", 900, 10);

  return {
    port: int(env, "PORT", 7070, 1),
    logLevel: env.LOG_LEVEL ?? "info",
    jwtSecret: jwtSecretBytes(secret),
    image: env.SANDBOX_IMAGE ?? "pi-gateway/sandbox:latest",
    proxyVolume: "pi-gateway-proxy-sock",
    runtime: env.SANDBOX_RUNTIME || undefined,
    workspacesDir,
    workspacesHostDir,
    pluginsHostDir,
    memoryBytes: parseBytes("SANDBOX_MEMORY", env.SANDBOX_MEMORY ?? "1g"),
    nanoCpus: Math.round(cpus * 1e9),
    pidsLimit: int(env, "SANDBOX_PIDS_LIMIT", 256, 16),
    tmpSize: "256m",
    shmSizeBytes: 64 * 1024 * 1024,
    idleSeconds,
    reapIntervalMs: Math.min(60, Math.max(5, Math.floor(idleSeconds / 4))) * 1000,
    containerPrefix: "pi-sbx-",
    instance: "default",
    fsTimeoutSeconds: 60,
  };
}
