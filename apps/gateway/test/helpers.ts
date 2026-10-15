import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptTemplate, Skill } from "@earendil-works/pi-coding-agent";
import { jwtSecretBytes, type McpServerConfig, type VisibleServer } from "@pi-gateway/shared";
import pino from "pino";
import { createGateway, type Gateway, type GatewayOverrides } from "../src/app.js";
import { type GatewayConfig, loadConfig } from "../src/config.js";
import type { McpRegistry, PluginResources, PromptService, ToolPolicy } from "../src/contracts.js";
import { openDatabase } from "../src/db.js";
import { type FakeBroker, type FakeBrokerTool, startFakeBroker } from "./fixtures/fake-broker.js";
import { type FakeLlm, startFakeLlm } from "./fixtures/fake-llm.js";
import { type FakeSandboxd, startFakeSandboxd } from "./fixtures/fake-sandboxd.js";

process.env.PI_OFFLINE = "1";

export const ALICE_KEY = "alice-key-0123456789abcdef";
export const BOB_KEY = "bob-key-0123456789abcdefgh";
export const SERVICE_KEY = "service-key-0123456789abcdef";
const SANDBOXD_SECRET = "sandboxd-secret-".padEnd(40, "x");
const BROKER_SECRET = "broker-secret-".padEnd(40, "y");

export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  /** 가짜 대신 실제 sandboxd를 쓴다 (Docker e2e) */
  sandboxd?: { url: string; secret: string };
  fakeSandbox?: { stallAttach?: boolean };
  brokerServers?: Record<string, FakeBrokerTool[]>;
  sandboxServers?: McpServerConfig[];
  toolPolicy?: ToolPolicy;
  skills?: Skill[];
  promptTemplates?: PromptTemplate[];
  overrides?: Partial<GatewayOverrides>;
}

export interface Harness {
  url: string;
  config: GatewayConfig;
  gateway: Gateway;
  llm: FakeLlm;
  sandbox: FakeSandboxd;
  broker: FakeBroker | null;
  /** PromptService 스텁이 돌려줄 텍스트 (바꾸면 새 세션부터 적용) */
  prompt: { text: string };
  post(body: unknown, opts?: { key?: string | null; headers?: Record<string, string> }): Promise<{ status: number; headers: Headers; json: any }>;
  stream(body: unknown, opts?: { key?: string | null; headers?: Record<string, string> }): Promise<{ status: number; events: SseEvent[]; raw: string; json?: any }>;
  close(): Promise<void>;
}

export function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event: ")) type = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (type) events.push({ type, data: JSON.parse(data) as Record<string, unknown> });
  }
  return events;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const llm = await startFakeLlm();
  const sandbox = await startFakeSandboxd(jwtSecretBytes(SANDBOXD_SECRET), options.fakeSandbox ?? {});
  const broker = options.brokerServers ? await startFakeBroker(jwtSecretBytes(BROKER_SECRET), options.brokerServers) : null;
  const dataDir = mkdtempSync(join(tmpdir(), "gw-test-"));
  const env: Record<string, string> = {
    LLM_BASE_URL: llm.url,
    LLM_MODELS: JSON.stringify([
      { id: "test-model", contextWindow: 32000, maxTokens: 4096 },
      { id: "think-model", contextWindow: 32000, maxTokens: 4096, reasoning: true },
    ]),
    DEFAULT_MODEL: "test-model",
    USER_API_KEYS: JSON.stringify({ alice: ALICE_KEY, bob: BOB_KEY }),
    API_KEY: SERVICE_KEY,
    SANDBOXD_URL: options.sandboxd?.url ?? sandbox.url,
    SANDBOXD_JWT_SECRET: options.sandboxd?.secret ?? SANDBOXD_SECRET,
    DATA_DIR: dataDir,
    PLUGINS_DIR: join(dataDir, "plugins"),
    TURN_QUEUE_TIMEOUT_SECONDS: "1",
    MCP_FORWARD_HEADERS: "x-user-token",
    MCP_METADATA_KEYS: "thread_id",
    SSE_KEEPALIVE_SECONDS: "1",
    LOG_LEVEL: "silent",
    ...(broker ? { BROKER_URL: broker.url, BROKER_JWT_SECRET: BROKER_SECRET, BROKER_ADMIN_TOKEN: "broker-admin-token-xyz" } : {}),
    ...(options.env ?? {}),
  };
  const config = loadConfig(env);
  const prompt = { text: "You are the test agent." };
  const prompts: PromptService = {
    snapshotForSession: () => ({ text: prompt.text, ref: { name: "test", version: 1, revision: "r1" } }),
  };
  const plugins: PluginResources = {
    skills: () => options.skills ?? [],
    promptTemplates: () => options.promptTemplates ?? [],
    revision: () => 0,
  };
  const mcpRegistry: McpRegistry = {
    sandboxServers: () => options.sandboxServers ?? [],
    brokerServersFor: async (): Promise<VisibleServer[]> =>
      Object.keys(options.brokerServers ?? {}).map((id) => ({ id, displayName: id, timeoutSec: 30 })),
  };
  const gateway = await createGateway(config, pino({ level: "silent" }), {
    db: openDatabase(":memory:"),
    prompts,
    plugins,
    mcpRegistry,
    ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    registerAdminRoutes: async () => {},
    piSettings: { retry: { enabled: false } },
    reaperIntervalMs: 0,
    ...(options.overrides ?? {}),
  });
  await gateway.app.listen({ host: "127.0.0.1", port: 0 });
  const address = gateway.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  const headersFor = (opts?: { key?: string | null; headers?: Record<string, string> }) => {
    const key = opts?.key === undefined ? ALICE_KEY : opts.key;
    return {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(opts?.headers ?? {}),
    };
  };

  return {
    url,
    config,
    gateway,
    llm,
    sandbox,
    broker,
    prompt,
    async post(body, opts) {
      const res = await fetch(`${url}/v1/responses`, { method: "POST", headers: headersFor(opts), body: JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
    },
    async stream(body, opts) {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: headersFor(opts),
        body: JSON.stringify({ ...(body as object), stream: true }),
      });
      const raw = await res.text();
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return { status: res.status, events: [], raw, json: raw ? JSON.parse(raw) : null };
      }
      return { status: res.status, events: parseSse(raw), raw };
    },
    async close() {
      try {
        await gateway.close();
      } finally {
        await llm.close();
        await sandbox.close();
        await broker?.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/** SSE 이벤트 중 특정 타입 */
export const ofType = (events: SseEvent[], type: string) => events.filter((e) => e.type === type);
export const last = (events: SseEvent[]) => events[events.length - 1]!;
