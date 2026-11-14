import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ADMIN_PRINCIPAL, AUD_BROKER_ADMIN, jwtSecretBytes, ListServersResponse, type McpServerView, signInternalToken } from "@pi-gateway/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { type Logger, pino } from "pino";
import type { Broker } from "../../../mcp-broker/src/app.js";
import { registerAdminRoutes } from "../../src/admin/index.js";
import { type GatewayConfig, loadConfig } from "../../src/config.js";
import type { AdminDeps } from "../../src/contracts.js";
import { type Db, openDatabase } from "../../src/db.js";
import { McpRegistryService } from "../../src/mcp-registry/service.js";
import { PluginService } from "../../src/plugins/service.js";
import { PromptManager } from "../../src/prompts/service.js";
import { SessionStore } from "../../src/sessions/store.js";
import { AdminRequests } from "../../src/tools/request-admin.js";
import { ToolSettings } from "../../src/tools/settings.js";
import { ToolStats } from "../../src/tools/stats.js";

export const ADMIN_KEY = "admin-key-for-tests-0123456789";
export const BROKER_JWT_SECRET = "b".repeat(40);

const createdDirs: string[] = [];

/** 테스트용 임시 디렉토리. 파일마다 afterAll(cleanupTempDirs)로 지운다. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-gw-platform-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makeConfig(options: { dataDir: string; pluginsDir: string; env?: Record<string, string | undefined> }): GatewayConfig {
  const env: Record<string, string | undefined> = {
    AUTH_DISABLED: "1",
    SANDBOXD_JWT_SECRET: "s".repeat(40),
    ADMIN_API_KEY: ADMIN_KEY,
    DATA_DIR: options.dataDir,
    PLUGINS_DIR: options.pluginsDir,
    LOG_LEVEL: "silent",
    PROMPT_LANGUAGE: "Korean",
    // broker를 쓰지 않는 테스트의 기본값: 연결되지 않는 주소 (broker를 쓰는 테스트는 brokerEnv로 덮어쓴다)
    ...brokerEnv({ url: "http://127.0.0.1:9", adminUrl: "http://127.0.0.1:9" }),
    ...options.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return loadConfig(env as NodeJS.ProcessEnv);
}

/** 로그를 문자열로 모아 두는 logger (비밀값이 로그에 없는지 확인용) */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { lines, logger };
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: GatewayConfig;
  prompts: PromptManager;
  mcp: McpRegistryService;
  plugins: PluginService;
  logs: string[];
  dbPath: string;
  /** Fastify와 DB를 닫는다 (임시 디렉토리는 cleanupTempDirs가 지운다) */
  close(): Promise<void>;
}

export async function buildHarness(options: {
  config?: GatewayConfig;
  env?: Record<string, string | undefined>;
} = {}): Promise<Harness> {
  const dataDir = tempDir("data");
  const pluginsDir = tempDir("plugins");
  const config = options.config ?? makeConfig({ dataDir, pluginsDir, ...(options.env ? { env: options.env } : {}) });
  const dbPath = join(config.dataDir, "gateway.db");
  const db = openDatabase(dbPath);
  const captured = captureLogger();
  const mcp = new McpRegistryService(db, config, captured.logger);
  const plugins = new PluginService(db, config, {
    registry: mcp,
    log: captured.logger,
    allowLocalSources: true,
  });
  const prompts = new PromptManager(db, config);
  const lines: string[] = captured.lines;
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const app = Fastify({ logger: { level: "trace", stream } });
  const deps: AdminDeps = {
    config,
    db,
    log: captured.logger,
    prompts,
    plugins,
    mcp,
    stats: () => ({ liveSessions: 2, activeTurns: 1, queuedTurns: 0 }),
    activeTurns: () => [],
    sandboxes: async () => [{ key: "u-abc", containerName: "sbx-u-abc", state: "running" }],
    chat: { respond: async () => ({}), cancel: async () => ({}), preview: async () => ({}), file: async () => ({}), forwardHeaders: () => mcp.forwardHeaders() },
    llm: {
      list: () => [],
      defaultModel: () => undefined,
      current: () => null,
      update: async () => Promise.reject(new Error("not used")),
      systemOne: () => null,
      setSystemOne: async () => Promise.reject(new Error("not used")),
      systemOneCalls: () => [],
    },
    sessions: new SessionStore(db),
    toolSettings: new ToolSettings(db),
    toolStats: new ToolStats(db),
    adminRequests: new AdminRequests(db),
  };
  await registerAdminRoutes(app, deps);
  await app.ready();
  const close = async () => {
    await app.close();
    if (db.open) db.close();
  };
  return { app, db, config, prompts, mcp, plugins, logs: lines, dbPath, close };
}

export const adminHeaders = { authorization: `Bearer ${ADMIN_KEY}` };

/** 쿠키 로그인. 쿠키 헤더 문자열을 돌려준다. */
export async function loginCookie(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/api/login",
    headers: { "x-admin-request": "1", "content-type": "application/json" },
    payload: { apiKey: ADMIN_KEY },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return raw.split(";")[0]!;
}

/** gateway DB 파일들(WAL 포함)에 문자열이 있는지 */
export function dbFilesContain(dbPath: string, needle: string): boolean {
  const dir = join(dbPath, "..");
  const base = dbPath.split("/").pop()!;
  return readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .some((f) => readFileSync(join(dir, f)).includes(Buffer.from(needle)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

// ── MCP broker ─────────────────────────────────────────────────────

/** 테스트가 gateway에 붙이는 실제 broker (apps/mcp-broker createBroker). 데이터는 임시 디렉토리에 둔다. */
export interface TestBroker {
  url: string;
  adminUrl: string;
  /** broker에 저장된 서버 (관리 평면 GET /admin/servers) */
  servers(): Promise<Map<string, McpServerView>>;
  /** broker가 비밀값마다 보여 주는 fingerprint (같은 KEK로 계산한다): 값이 broker까지 갔는지 확인용 */
  fingerprint(value: string): string;
  /** false면 broker를 멈추고 (연결이 거절된다), true면 같은 주소·데이터로 다시 띄운다 (broker 장애 흉내) */
  setUp(up: boolean): Promise<void>;
  close(): Promise<void>;
}

/** 다른 테스트가 broker 모듈을 불러오지 않도록 동적 import한다. */
export async function startBroker(): Promise<TestBroker> {
  const { createBroker, createLogger } = await import("../../../mcp-broker/src/app.js");
  const { loadBrokerConfig } = await import("../../../mcp-broker/src/config.js");
  const { SecretCipher } = await import("../../../mcp-broker/src/crypto.js");
  const kek = randomBytes(32);
  const config = loadBrokerConfig({ BROKER_JWT_SECRET, BROKER_KEK: kek.toString("base64"), DATA_DIR: join(tempDir("broker"), "data") });
  const cipher = new SecretCipher(kek);
  const port = (app: FastifyInstance) => (app.server.address() as AddressInfo).port;
  let ports = { data: 0, admin: 0 };
  let broker: Broker | undefined;
  const start = async () => {
    const b = createBroker(config, { log: createLogger("silent") });
    await b.dataPlane.listen({ host: "127.0.0.1", port: ports.data });
    await b.adminPlane.listen({ host: "127.0.0.1", port: ports.admin });
    ports = { data: port(b.dataPlane), admin: port(b.adminPlane) };
    broker = b;
  };
  const stop = async () => {
    await broker?.close(500);
    broker = undefined;
  };
  await start();
  return {
    url: `http://127.0.0.1:${ports.data}`,
    adminUrl: `http://127.0.0.1:${ports.admin}`,
    async servers() {
      const token = await signInternalToken(jwtSecretBytes(BROKER_JWT_SECRET), AUD_BROKER_ADMIN, { sub: ADMIN_PRINCIPAL });
      const res = await broker!.adminPlane.inject({ method: "GET", url: "/admin/servers", headers: { authorization: `Bearer ${token}` } });
      return new Map(ListServersResponse.parse(res.json()).servers.map((v) => [v.config.id, v]));
    },
    fingerprint: (value) => cipher.fingerprint(value),
    setUp: async (up) => {
      if (!up) await stop();
      else if (!broker) await start();
    },
    close: stop,
  };
}

export function brokerEnv(b: Pick<TestBroker, "url" | "adminUrl">): Record<string, string> {
  return { BROKER_URL: b.url, BROKER_ADMIN_URL: b.adminUrl, BROKER_JWT_SECRET };
}
