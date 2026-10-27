import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { AUD_BROKER, AUD_BROKER_ADMIN, type InternalClaims, signInternalToken } from "@pi-gateway/shared";
import { pino } from "pino";
import { type Broker, createBroker } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";

export function testConfig(overrides: Partial<BrokerConfig> = {}): BrokerConfig {
  const root = mkdtempSync(join(tmpdir(), "mcp-broker-test-"));
  return {
    host: "127.0.0.1",
    port: 0,
    adminHost: "127.0.0.1",
    adminPort: 0,
    logLevel: "silent",
    dataDir: join(root, "data"),
    jwtSecret: new TextEncoder().encode(randomBytes(32).toString("hex")),
    kek: randomBytes(32),
    limits: {
      maxConnections: 32,
      idleTtlSeconds: 300,
      callTimeoutCapSeconds: 600,
      // 전체 병렬 실행처럼 부하가 클 때도 넉넉하게 기다린다.
      connectTimeoutSeconds: 60,
      maxResultBytes: 1024 * 1024,
      maxRequestBodyBytes: 4 * 1024 * 1024,
      toolsCacheSeconds: 60,
    },
    ...overrides,
  };
}

export interface TestBroker {
  broker: Broker;
  config: BrokerConfig;
  dataUrl: string;
  /** broker가 남긴 로그 (JSON 한 줄씩) */
  logs: Record<string, unknown>[];
  token(claims: InternalClaims): Promise<string>;
  admin(method: "GET" | "PUT" | "POST" | "DELETE", url: string, body?: unknown): Promise<{ status: number; text: string; json: () => any }>;
  /** 관리 API로 http upstream 서버를 등록한다 */
  addHttpServer(id: string, url: string, extra?: { headers?: Record<string, string> } & Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export async function startTestBroker(overrides: Partial<BrokerConfig> = {}): Promise<TestBroker> {
  const config = testConfig(overrides);
  const logs: Record<string, unknown>[] = [];
  const broker = createBroker(config, { log: pino({ level: "info" }, { write: (line: string) => logs.push(JSON.parse(line)) }) });
  const address = await broker.dataPlane.listen({ host: "127.0.0.1", port: 0 });
  const admin: TestBroker["admin"] = async (method, url, body) => {
    const token = await signInternalToken(config.jwtSecret, AUD_BROKER_ADMIN, { sub: "_admin" });
    const res = await broker.adminPlane.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, text: res.body, json: () => JSON.parse(res.body) };
  };
  return {
    broker,
    config,
    dataUrl: address,
    logs,
    token: (claims) => signInternalToken(config.jwtSecret, AUD_BROKER, claims),
    admin,
    async addHttpServer(id, url, extra = {}) {
      const { headers = {}, ...rest } = extra;
      const res = await admin("PUT", `/admin/servers/${id}`, { runIn: "broker", transport: { type: "http", url, headers }, ...rest });
      if (res.status >= 300) throw new Error(`addHttpServer failed: ${res.status} ${res.text}`);
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
