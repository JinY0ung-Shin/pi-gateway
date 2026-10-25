import { isIP } from "node:net";
import { jwtSecretBytes, readSecret } from "@pi-gateway/shared";
import { z } from "zod";

/**
 * gateway 설정. 모든 값은 환경변수에서 읽는다 (비밀값은 `NAME_FILE`도 지원).
 * 이 파일은 여러 작업 레인이 함께 쓰므로, 필드를 추가할 때는 기존 필드의 의미를 바꾸지 않는다.
 */

export interface GatewayConfig {
  host: string;
  port: number;
  logLevel: string;
  /** 세션 JSONL, gateway.db */
  dataDir: string;
  /** 설치된 plugin 루트. gateway·sandbox·broker에서 같은 경로다. */
  pluginsDir: string;
  auth: {
    /** 서비스 키. 이 키로 들어온 요청은 body.user를 그대로 믿는다. */
    apiKey: string | undefined;
    /** user → key. 이 키로 들어온 요청은 키가 principal을 정한다. */
    userApiKeys: Record<string, string>;
    adminApiKey: string | undefined;
    /** 키가 하나도 없을 때 인증 없이 허용할지 (개발용) */
    disabled: boolean;
  };
  sandboxd: {
    url: string;
    jwtSecret: Uint8Array;
  };
  /** 비밀키가 필요한 MCP 서버를 프록시하는 mcp-broker. 데이터·관리 평면 모두 같은 키의 내부 JWT로 부른다. */
  broker: {
    url: string;
    adminUrl: string;
    jwtSecret: Uint8Array;
  };
  sessions: {
    idleSeconds: number;
    maxConcurrentTurns: number;
    maxConcurrentTurnsPerUser: number;
    queueTimeoutSeconds: number;
    maxQueuedTurns: number;
    /** 비스트리밍 요청의 최대 실행 시간 */
    nonStreamTimeoutSeconds: number;
  };
  mcp: {
    /** broker JWT ctx.headers로 넘길 클라이언트 헤더 이름 (소문자) */
    forwardHeaders: string[];
    /** MCP 템플릿에서 쓸 수 있는 요청 metadata 키 */
    metadataKeys: string[];
  };
  prompts: {
    language: string;
  };
  admin: {
    /** 관리 화면 세션 쿠키 서명 키 */
    cookieSecret: string;
  };
  sse: {
    keepaliveSeconds: number;
  };
  /**
   * Fastify `trustProxy` (TRUST_PROXY). 프록시 뒤에서 req.ip·req.protocol을 클라이언트 기준으로 보려면 설정한다.
   * false(기본) · true · 앞단 프록시 hop 수 · 신뢰할 프록시 주소/CIDR 목록.
   */
  trustProxy: boolean | string[];
}

/** "10.0.0.0/8", "192.168.1.5", "fd00::/8" 형식을 읽는다. 잘못되면 null. */
function parseCidr(value: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const parts = value.trim().split("/");
  if (parts.length > 2) return null;
  const [address, prefixText] = parts;
  if (!address) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = (raw ?? "").trim();
  if (value === "" || value === "false" || value === "0") return false;
  if (value === "true") return true;
  // Fastify 5는 hop 수(숫자)를 받으면 일부러 아무 프록시도 믿지 않는다 (fail closed). 조용히 무시되지 않게 거부한다.
  if (/^\d+$/.test(value)) {
    throw new Error(
      `TRUST_PROXY hop counts are not supported ('${value}'): Fastify ignores them. Use "true" (trust any proxy) or the proxy addresses as a comma list of IPs/CIDRs, e.g. "10.0.0.0/8,172.16.0.0/12".`,
    );
  }
  const entries = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (!parseCidr(entry)) throw new Error(`TRUST_PROXY has an invalid entry '${entry}' (use true, or proxy IPs/CIDRs)`);
  }
  return entries;
}

const int = (name: string, fallback: number, env: NodeJS.ProcessEnv): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function parseJson<T>(name: string, raw: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const userApiKeys = parseJson(
    "USER_API_KEYS",
    readSecret(env, "USER_API_KEYS"),
    z.record(z.string(), z.string().min(16)),
    {} as Record<string, string>,
  );
  const apiKey = readSecret(env, "API_KEY");
  const adminApiKey = readSecret(env, "ADMIN_API_KEY");
  const disabled = env.AUTH_DISABLED === "1";
  if (!apiKey && Object.keys(userApiKeys).length === 0 && !disabled) {
    throw new Error("Set API_KEY or USER_API_KEYS (or AUTH_DISABLED=1 for local development)");
  }

  const sandboxdSecret = readSecret(env, "SANDBOXD_JWT_SECRET");
  if (!sandboxdSecret) throw new Error("SANDBOXD_JWT_SECRET (or _FILE) is required");

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);

  const brokerSecret = readSecret(env, "BROKER_JWT_SECRET");
  if (!brokerSecret) throw new Error("BROKER_JWT_SECRET (or _FILE) is required");

  return {
    host: env.HOST || "0.0.0.0",
    port: int("PORT", 8080, env),
    logLevel: env.LOG_LEVEL || "info",
    dataDir: env.DATA_DIR || "/data",
    pluginsDir: env.PLUGINS_DIR || "/opt/plugins",
    auth: { apiKey, userApiKeys, adminApiKey, disabled },
    sandboxd: {
      url: (env.SANDBOXD_URL || "http://sandboxd:7070").replace(/\/+$/, ""),
      jwtSecret: jwtSecretBytes(sandboxdSecret),
    },
    broker: {
      url: (env.BROKER_URL || "http://mcp-broker:7080").replace(/\/+$/, ""),
      adminUrl: (env.BROKER_ADMIN_URL || "http://mcp-broker:7081").replace(/\/+$/, ""),
      jwtSecret: jwtSecretBytes(brokerSecret),
    },
    sessions: {
      idleSeconds: int("SESSION_IDLE_SECONDS", 300, env),
      maxConcurrentTurns: int("MAX_CONCURRENT_TURNS", 16, env),
      maxConcurrentTurnsPerUser: int("MAX_CONCURRENT_TURNS_PER_USER", 3, env),
      queueTimeoutSeconds: int("TURN_QUEUE_TIMEOUT_SECONDS", 120, env),
      maxQueuedTurns: int("TURN_QUEUE_MAX_WAITERS", 256, env),
      nonStreamTimeoutSeconds: int("NON_STREAM_TIMEOUT_SECONDS", 600, env),
    },
    mcp: {
      forwardHeaders: list(env.MCP_FORWARD_HEADERS).map((h) => h.toLowerCase()),
      metadataKeys: list(env.MCP_METADATA_KEYS),
    },
    prompts: { language: env.PROMPT_LANGUAGE || "Korean" },
    admin: {
      cookieSecret: readSecret(env, "ADMIN_COOKIE_SECRET") ?? adminApiKey ?? "",
    },
    sse: { keepaliveSeconds: int("SSE_KEEPALIVE_SECONDS", 15, env) },
    trustProxy,
  };
}
