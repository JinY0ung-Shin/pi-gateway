import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type CallToolResult, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  AUD_BROKER,
  bearerToken,
  collectTemplateRefs,
  findLiteralCredentials,
  type InternalClaims,
  jwtSecretBytes,
  McpServerConfig,
  requiredSecretNames,
  signInternalToken,
  verifyInternalToken,
} from "@pi-gateway/shared";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { PlatformLogger } from "../../src/admin/logger.js";
import { registerAdminRoutes } from "../../src/admin/index.js";
import { type GatewayConfig, loadConfig } from "../../src/config.js";
import type { AdminDeps } from "../../src/contracts.js";
import { type Db, openDatabase } from "../../src/db.js";
import { McpRegistryService } from "../../src/mcp-registry/service.js";
import { PluginService } from "../../src/plugins/service.js";
import { PromptManager } from "../../src/prompts/service.js";

export const ADMIN_KEY = "admin-key-for-tests-0123456789";
export const BROKER_ADMIN_TOKEN = "broker-admin-token-0123456789-abcdefgh";
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
    LLM_MODELS: JSON.stringify([{ id: "test-model", contextWindow: 8192, maxTokens: 1024 }]),
    LLM_BASE_URL: "http://127.0.0.1:9/v1",
    AUTH_DISABLED: "1",
    SANDBOXD_JWT_SECRET: "s".repeat(40),
    ADMIN_API_KEY: ADMIN_KEY,
    DATA_DIR: options.dataDir,
    PLUGINS_DIR: options.pluginsDir,
    LOG_LEVEL: "silent",
    PROMPT_LANGUAGE: "Korean",
    ...options.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return loadConfig(env as NodeJS.ProcessEnv);
}

/** 로그를 문자열로 모아 두는 logger (비밀값이 로그에 없는지 확인용) */
export function captureLogger(): { logger: PlatformLogger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (obj: object, msg?: string) => lines.push(JSON.stringify({ level, msg, ...obj }));
  return { lines, logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") } };
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
    prompts,
    plugins,
    mcp,
    stats: () => ({ liveSessions: 2, activeTurns: 1, queuedTurns: 0 }),
    sandboxes: async () => [{ key: "u-abc", containerName: "sbx-u-abc", state: "running" }],
    chat: { respond: async () => ({}), cancel: async () => ({}) },
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
  requests: { method: string; url: string; actor?: string }[];
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
      secrets: [...set.keys()].map((name) => ({ name, setAt: "2026-10-16T00:00:00.000Z", fingerprint: `fp-${name.length}` })),
      missingSecrets: required.filter((n) => !set.has(n)),
      status: { processes: 0 },
    };
  };

  app.addHook("onRequest", async (req, reply) => {
    if (down) {
      refused.push({ method: req.method, url: req.url });
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    const actor = req.headers["x-admin-actor"];
    requests.push({ method: req.method, url: req.url, ...(typeof actor === "string" ? { actor: decodeURIComponent(actor) } : {}) });
    if (req.url.startsWith("/admin/")) {
      if (req.headers.authorization !== `Bearer ${BROKER_ADMIN_TOKEN}`) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "bad admin token" } });
      }
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
    if (config.transport.type === "stdio") {
      const base = config.transport.command.split("/").pop() ?? "";
      if (["npx", "uvx", "bunx", "pnpx", "pipx", "npm", "pnpm", "yarn"].includes(base)) return bad(reply, `command '${base}' is not allowed`);
    }
    if (JSON.stringify(config.transport).includes("{{plugin_root}}")) return bad(reply, "unresolved {{plugin_root}}");
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
  app.put<{ Params: { id: string; name: string }; Body: { value?: string } }>("/admin/servers/:id/secrets/:name", async (req, reply) => {
    if (!servers.has(req.params.id)) return reply.code(404).send({ error: { code: "not_found", message: "no such server" } });
    const set = secrets.get(req.params.id) ?? new Map<string, string>();
    set.set(req.params.name, String(req.body?.value));
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
  app.get<{ Params: { id: string } }>("/admin/servers/:id/tools", async () => ({ tools: [{ name: "search", description: "검색" }] }));
  app.get("/admin/audit", async () => ({ events: [{ at: "2026-10-16T00:00:00.000Z", actor: "admin", action: "server.put", serverId: "x" }] }));

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
    BROKER_ADMIN_TOKEN,
  };
}

/** 실제 broker(store.ts transportTarget)와 같은 기준: 이 값이 바뀌면 저장된 비밀키를 지운다. */
function transportTarget(config: McpServerConfig): string {
  const t = config.transport;
  if (t.type === "stdio") {
    const env = Object.entries(t.env).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify({ type: "stdio", command: t.command, args: t.args, cwd: t.cwd ?? null, env });
  }
  let origin: string;
  try {
    origin = /\{\{/.test(t.url.split("/").slice(0, 3).join("/")) ? t.url : new URL(t.url).origin;
  } catch {
    origin = t.url;
  }
  const headers = Object.entries(t.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const urlSecrets = collectTemplateRefs({ transport: { ...t, headers: {} } })
    .refs.flatMap((r) => (r.kind === "secret" ? [r.name] : []))
    .sort();
  return JSON.stringify({ type: "http", origin, headers, urlSecrets });
}

/** gateway가 붙는 broker. 가짜(startFakeBroker)와 실제(startRealBroker)를 같은 모양으로 쓴다. */
export interface TestBroker {
  dataUrl: string;
  adminUrl: string;
  close(): Promise<void>;
}

/** broker 테스트의 최소 MCP stdio 서버 (의존성 없음) */
export const BROKER_STDIO_FIXTURE = fileURLToPath(new URL("../../../mcp-broker/test/fixtures/stdio-server.mjs", import.meta.url));

/**
 * 실제 broker(apps/mcp-broker createBroker). stdio 자식은 지금 node로 띄운다.
 * 다른 테스트가 broker 모듈을 불러오지 않도록 동적 import한다.
 */
export async function startRealBroker(): Promise<TestBroker> {
  const { createBroker, createLogger } = await import("../../../mcp-broker/src/app.js");
  const { loadBrokerConfig } = await import("../../../mcp-broker/src/config.js");
  const dir = tempDir("real-broker");
  const config = loadBrokerConfig({
    BROKER_JWT_SECRET,
    BROKER_ADMIN_TOKEN,
    BROKER_KEK: randomBytes(32).toString("base64"),
    DATA_DIR: join(dir, "data"),
    PLUGINS_DIR: join(dir, "plugins"),
    BROKER_STDIO_WORK_ROOT: join(dir, "work"),
    BROKER_STDIO_PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
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

/** gateway와 같은 방식(pi-mcp, 요청마다 내부 JWT)으로 broker data plane의 도구를 부른다 */
export async function callBrokerTool(
  b: TestBroker,
  serverId: string,
  tool: string,
  claims: InternalClaims = { sub: "u-test", sid: "s-test" },
): Promise<CallToolResult> {
  const secret = jwtSecretBytes(BROKER_JWT_SECRET);
  const client = new McpClient({ name: "pi-gateway-platform-test", version: "0.0.0", requestTimeoutMs: 30_000 });
  await client.connect(
    new StreamableHttpTransport({
      url: `${b.dataUrl}/mcp/${serverId}`,
      openGetStream: false,
      authProvider: { token: () => signInternalToken(secret, AUD_BROKER, claims, 60) },
    }),
  );
  try {
    return await client.callTool(tool, {});
  } finally {
    await client.close();
  }
}
