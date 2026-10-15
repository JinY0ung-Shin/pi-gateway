import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { AUD_BROKER, type InternalClaims, signInternalToken } from "@pi-gateway/shared";
import { pino } from "pino";
import { type Broker, createBroker } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";

export const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

export function testConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  const root = mkdtempSync(join(tmpdir(), "mcp-broker-test-"));
  return {
    host: "127.0.0.1",
    port: 0,
    adminHost: "127.0.0.1",
    adminPort: 0,
    logLevel: "silent",
    dataDir: join(root, "data"),
    pluginsDir: join(root, "plugins"),
    jwtSecret: new TextEncoder().encode(randomBytes(32).toString("hex")),
    adminToken: randomBytes(32).toString("hex"),
    kek: randomBytes(32),
    limits: {
      maxProcesses: 16,
      maxProcessesPerServer: 8,
      maxConnections: 32,
      idleTtlSeconds: 300,
      callTimeoutCapSeconds: 600,
      // 전체 병렬 실행처럼 부하가 클 때도 넉넉하게 기다린다.
      connectTimeoutSeconds: 60,
      maxResultBytes: 1024 * 1024,
      maxRequestBodyBytes: 4 * 1024 * 1024,
      toolsCacheSeconds: 60,
    },
    stdio: {
      uidRange: null,
      path: process.env.PATH ?? "/usr/bin:/bin",
      lang: "C.UTF-8",
      workRoot: join(root, "work"),
      maxMessageBytes: 16 * 1024 * 1024,
      commandAllowlist: [],
    },
    ...overrides,
  };
}

export interface TestBroker {
  broker: Broker;
  config: BrokerConfig;
  dataUrl: string;
  token(claims: InternalClaims): Promise<string>;
  admin(method: "GET" | "PUT" | "POST" | "DELETE", url: string, body?: unknown): Promise<{ status: number; text: string; json: () => any }>;
  /** 관리 API로 stdio fixture 서버를 등록한다 */
  addStdioServer(id: string, extra?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export async function startTestBroker(overrides: Partial<BrokerConfig> = {}): Promise<TestBroker> {
  const config = testConfig(overrides);
  const broker = createBroker(config, { log: pino({ level: "silent" }) });
  const address = await broker.dataPlane.listen({ host: "127.0.0.1", port: 0 });
  const admin: TestBroker["admin"] = async (method, url, body) => {
    const res = await broker.adminPlane.inject({
      method,
      url,
      headers: { authorization: `Bearer ${config.adminToken}`, "x-admin-actor": "tester" },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, text: res.body, json: () => JSON.parse(res.body) };
  };
  return {
    broker,
    config,
    dataUrl: address,
    token: (claims) => signInternalToken(config.jwtSecret, AUD_BROKER, claims),
    admin,
    async addStdioServer(id, extra = {}) {
      const { transport: extraTransport, ...rest } = extra as { transport?: Record<string, unknown> };
      const res = await admin("PUT", `/admin/servers/${id}`, {
        runIn: "broker",
        transport: { type: "stdio", command: process.execPath, args: [STDIO_FIXTURE], ...extraTransport },
        ...rest,
      });
      if (res.status >= 300) throw new Error(`addStdioServer failed: ${res.status} ${res.text}`);
    },
    async close() {
      await broker.close(1000);
      rmSync(join(config.dataDir, ".."), { recursive: true, force: true });
    },
  };
}

/** gateway와 같은 방식(pi-mcp)으로 broker에 붙는다 */
export async function piClient(tb: TestBroker, serverId: string, claims: InternalClaims): Promise<McpClient> {
  const client = new McpClient({ name: "pi-gateway-test", version: "0.0.0", requestTimeoutMs: 90_000 });
  const transport = new StreamableHttpTransport({
    url: `${tb.dataUrl}/mcp/${serverId}`,
    openGetStream: false,
    authProvider: { token: () => tb.token(claims) },
  });
  await client.connect(transport);
  return client;
}

export function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
