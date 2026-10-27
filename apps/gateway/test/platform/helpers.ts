import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  AUD_BROKER,
  AUD_BROKER_ADMIN,
  bearerToken,
  findLiteralCredentials,
  jwtSecretBytes,
  McpServerConfig,
  PutSecretRequest,
  requiredSecretNames,
  SecretName,
  transportTarget,
  verifyInternalToken,
} from "@pi-gateway/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { type Logger, pino } from "pino";
import { registerAdminRoutes } from "../../src/admin/index.js";
import { type GatewayConfig, loadConfig } from "../../src/config.js";
import type { AdminDeps } from "../../src/contracts.js";
import { type Db, openDatabase } from "../../src/db.js";
import { McpRegistryService } from "../../src/mcp-registry/service.js";
import { PluginService } from "../../src/plugins/service.js";
import { PromptManager } from "../../src/prompts/service.js";
import { SessionStore } from "../../src/sessions/store.js";
import { ToolSettings } from "../../src/tools/settings.js";

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
    ...brokerEnv("http://127.0.0.1:9"),
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
  allowLocalSources?: boolean;
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
    allowLocalSources: options.allowLocalSources ?? true,
    gitTimeoutMs: 60_000,
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
    sandboxes: async () => [{ key: "u-abc", containerName: "sbx-u-abc", state: "running" }],
    chat: { respond: async () => ({}), cancel: async () => ({}), preview: async () => ({}), forwardHeaders: () => mcp.forwardHeaders() },
    llm: { list: () => [], defaultModel: () => undefined, current: () => null, update: async () => Promise.reject(new Error("not used")) },
    sessions: new SessionStore(db),
    toolSettings: new ToolSettings(db),
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

// ── 가짜 MCP broker ────────────────────────────────────────────────

export interface FakeBroker {
  url: string;
  app: FastifyInstance;
  servers: Map<string, McpServerConfig>;
  /** 받은 비밀값 (serverId → name → value) — 관리 API가 broker까지 전달했는지 확인용 */
  secrets: Map<string, Map<string, string>>;
  requests: { method: string; url: string }[];
  /** true면 모든 연결을 끊는다 (broker 장애 흉내) */
  setDown(down: boolean): void;
  /** 꺼져 있을 때 들어와서 끊은 요청 */
  refused: { method: string; url: string }[];
  close(): Promise<void>;
}

export async function startFakeBroker(): Promise<FakeBroker> {
  const app = Fastify();
  const servers = new Map<string, McpServerConfig>();
  const secrets = new Map<string, Map<string, string>>();
  const requests: FakeBroker["requests"] = [];
  const refused: FakeBroker["refused"] = [];
  const jwtSecret = jwtSecretBytes(BROKER_JWT_SECRET);
  let down = false;

  const view = (config: McpServerConfig) => {
    const set = secrets.get(config.id) ?? new Map<string, string>();
    const required = requiredSecretNames(config);
    return {
      config,
      secrets: [...set].map(([name, value]) => ({
        name,
        setAt: "2026-10-16T00:00:00.000Z",
        fingerprint: `fp-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`,
      })),
      missingSecrets: required.filter((n) => !set.has(n)),
    };
  };

  app.addHook("onRequest", async (req, reply) => {
    if (down) {
      refused.push({ method: req.method, url: req.url });
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    requests.push({ method: req.method, url: req.url });
    if (req.url.startsWith("/admin/")) {
      const token = bearerToken(req.headers.authorization);
      const valid = token !== null && (await verifyInternalToken(jwtSecret, AUD_BROKER_ADMIN, token).then(() => true, () => false));
      if (!valid) return reply.code(401).send({ error: { code: "unauthorized", message: "bad admin token" } });
    }
  });

  app.get("/admin/servers", async () => ({ servers: [...servers.values()].map(view) }));
  // 실제 broker(apps/mcp-broker admin-plane)와 같은 규칙. broker-contract.test.ts가 둘을 비교한다.
  const bad = (reply: FastifyReply, message: string) => reply.code(400).send({ error: { code: "invalid_request", message } });
  app.get<{ Params: { id: string } }>("/admin/servers/:id", async (req, reply) => {
    const config = servers.get(req.params.id);
    if (!config) return reply.code(404).send({ error: { code: "not_found", message: "no such server" } });
    return view(config);
  });
  app.put<{ Params: { id: string }; Body: unknown }>("/admin/servers/:id", async (req, reply) => {
    const parsed = McpServerConfig.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.message);
    const config = parsed.data;
    if (config.id !== req.params.id) return bad(reply, "config.id must match the URL");
    if (config.runIn !== "broker") return bad(reply, "runIn must be broker");
    if (config.id === "servers") return bad(reply, "id 'servers' is reserved");
    const literals = findLiteralCredentials(config);
    if (literals.length > 0) return bad(reply, literals.join("; "));
    const previous = servers.get(config.id);
    if (previous && transportTarget(previous) !== transportTarget(config)) secrets.delete(config.id);
    servers.set(config.id, config);
    return reply.code(previous ? 200 : 201).send(view(config));
  });
  app.delete<{ Params: { id: string } }>("/admin/servers/:id", async (req, reply) => {
    if (!servers.delete(req.params.id)) return reply.code(404).send({ error: { code: "not_found", message: "no such server" } });
    secrets.delete(req.params.id);
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string; name: string }; Body: unknown }>("/admin/servers/:id/secrets/:name", async (req, reply) => {
    if (!SecretName.safeParse(req.params.name).success) return bad(reply, "bad secret name");
    const body = PutSecretRequest.safeParse(req.body);
    if (!body.success) return bad(reply, "bad secret body");
    if (!servers.has(req.params.id)) return reply.code(404).send({ error: { code: "not_found", message: "no such server" } });
    const set = secrets.get(req.params.id) ?? new Map<string, string>();
    set.set(req.params.name, body.data.value);
    secrets.set(req.params.id, set);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string; name: string } }>("/admin/servers/:id/secrets/:name", async (req, reply) => {
    secrets.get(req.params.id)?.delete(req.params.name);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/admin/servers/:id/test", async (req, reply) => {
    if (!servers.has(req.params.id)) return reply.code(404).send({ error: { code: "not_found", message: "no such server" } });
    return { ok: true, tools: [{ name: "search", description: "검색" }], durationMs: 3 };
  });

  app.get("/mcp/servers", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: { code: "unauthorized", message: "no token" } });
    try {
      const claims = await verifyInternalToken(jwtSecret, AUD_BROKER, token);
      if (!claims.sid) return reply.code(400).send({ error: { code: "invalid_request", message: "no sid" } });
    } catch {
      return reply.code(401).send({ error: { code: "unauthorized", message: "bad token" } });
    }
    return {
      servers: [...servers.values()]
        .filter((c) => c.enabled && view(c).missingSecrets.length === 0)
        .map((c) => ({ id: c.id, ...(c.displayName ? { displayName: c.displayName } : {}), timeoutSec: c.timeoutSec })),
    };
  });

  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url: address,
    app,
    servers,
    secrets,
    requests,
    refused,
    setDown: (value) => {
      down = value;
    },
    close: () => app.close(),
  };
}

export function brokerEnv(url: string): Record<string, string> {
  return {
    BROKER_URL: url,
    BROKER_ADMIN_URL: url,
    BROKER_JWT_SECRET,
  };
}


/** gateway가 붙는 broker. 가짜(startFakeBroker)와 실제(startRealBroker)를 같은 모양으로 쓴다. */
export interface TestBroker {
  dataUrl: string;
  adminUrl: string;
  close(): Promise<void>;
}

/**
 * 실제 broker(apps/mcp-broker createBroker).
 * 다른 테스트가 broker 모듈을 불러오지 않도록 동적 import한다.
 */
export async function startRealBroker(): Promise<TestBroker> {
  const { createBroker, createLogger } = await import("../../../mcp-broker/src/app.js");
  const { loadBrokerConfig } = await import("../../../mcp-broker/src/config.js");
  const dir = tempDir("real-broker");
  const config = loadBrokerConfig({
    BROKER_JWT_SECRET,
    BROKER_KEK: randomBytes(32).toString("base64"),
    DATA_DIR: join(dir, "data"),
    LOG_LEVEL: "silent",
  });
  const broker = createBroker(config, { log: createLogger("silent") });
  const dataUrl = await broker.dataPlane.listen({ host: "127.0.0.1", port: 0 });
  const adminUrl = await broker.adminPlane.listen({ host: "127.0.0.1", port: 0 });
  return { dataUrl, adminUrl, close: () => broker.close(500) };
}

export async function startFakeTestBroker(): Promise<TestBroker & { fake: FakeBroker }> {
  const fake = await startFakeBroker();
  return { fake, dataUrl: fake.url, adminUrl: fake.url, close: () => fake.close() };
}

/** gateway 설정용 (data plane과 관리 평면 주소가 다를 수 있다) */
export function testBrokerEnv(b: TestBroker): Record<string, string> {
  return { ...brokerEnv(b.dataUrl), BROKER_ADMIN_URL: b.adminUrl };
}
