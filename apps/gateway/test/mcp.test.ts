import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServerConfig, SANDBOXD_ROUTES } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpToolCache, pluginDataDirs, resolveSandboxCommand, SANDBOX_SYSTEM_PATH } from "../src/mcp-client/connections.js";
import { searchTerms } from "../src/mcp-client/proxy.js";
import { bombPng, tinyPng } from "./fixtures/images.js";
import { BOB_KEY, type Harness, last, ofType, startHarness } from "./helpers.js";

const stdioServer = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    brokerServers: {
      demo: [
        {
          name: "echo",
          description: "echo back",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          handler: (args, claims) => ({ text: `echo:${String(args.text)} user=${claims.sub} token=${claims.ctx?.headers?.["x-user-token"] ?? "-"}` }),
        },
        { name: "fail", handler: () => ({ text: "upstream refused", isError: true }) },
        { name: "rows", handler: () => ({ text: Array.from({ length: 10_000 }, (_, i) => `row ${i}`).join("\n") }) },
        {
          name: "picture",
          handler: (args) => ({
            content: [{ type: "image", data: (args.bomb ? bombPng() : tinyPng()).toString("base64"), mimeType: "image/png" }],
          }),
        },
      ],
    },
    sandboxServers: [
      McpServerConfig.parse({
        id: "local",
        runIn: "sandbox",
        scope: "per-session",
        transport: { type: "stdio", command: process.execPath, args: [stdioServer], env: { THREAD_ID: "{{metadata:thread_id}}" } },
      }),
    ],
  });
});
afterAll(async () => {
  await h.close();
});

describe("MCP via the broker", () => {
  it("offers MCP servers through mcp_search and mcp_call with a fresh JWT carrying the user and forwarded headers", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "m1", name: "mcp_call", arguments: { name: "mcp__demo__echo", arguments: { text: "hi" } } }] }, { text: "done" });
    const before = h.llm.requests.length;
    const res = await h.stream({ input: "use mcp" }, { headers: { "x-user-token": "tok-123", "x-other": "not-forwarded" } });
    const tools = h.llm.requests[before]!.tools ?? [];
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("mcp_search");
    expect(names).toContain("mcp_call");
    expect(names.filter((n) => n.startsWith("mcp__demo__"))).toEqual([]);
    expect(tools.find((t) => t.function.name === "mcp_search")!.function.description).toContain("- demo");
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(false);
    expect(result.content).toBe("echo:hi user=alice token=tok-123");
    expect(last(res.events).type).toBe("response.completed");

    expect(h.broker!.authFailures).toEqual([]);
    const methods = h.broker!.records.map((r) => r.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    expect(methods).toContain("tools/call");
    const call = h.broker!.records.find((r) => r.method === "tools/call")!;
    expect(call.claims.sub).toBe("alice");
    const sessionId = /^resp_(.+)_\d+$/.exec((last(res.events).data.response as any).id)![1];
    expect(call.claims.sid).toBe(sessionId);
    expect(call.claims.ctx?.headers).toEqual({ "x-user-token": "tok-123" });
  });

  it("maps MCP isError results to tool errors", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "m2", name: "mcp__demo__fail", arguments: {} }] }, { text: "ok" });
    const res = await h.stream({ input: "fail mcp" });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result).toMatchObject({ is_error: true, content: "upstream refused" });
  });
});

describe("mcp_search and mcp_call", () => {
  it("returns matching tools with their parameter schemas", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "q1", name: "mcp_search", arguments: { query: "echo back" } }] }, { text: "ok" });
    const res = await h.stream({ input: "find" });
    const content = String(ofType(res.events, "response.tool_result")[0]!.data.content);
    expect(content.startsWith("## mcp__demo__echo\necho back\nParameters: ")).toBe(true);
    expect(content).toContain('"required":["text"]');
  });

  it("returns the schema when arguments do not match, and points unknown names at mcp_search", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "v1", name: "mcp_call", arguments: { name: "mcp__demo__echo", arguments: {} } }] },
      { toolCalls: [{ id: "v2", name: "mcp_call", arguments: { name: "mcp__demo__nope" } }] },
      { text: "ok" },
    );
    const res = await h.stream({ input: "bad calls" });
    const [missing, unknown] = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(missing!.is_error).toBe(true);
    expect(String(missing!.content)).toContain('Parameters of mcp__demo__echo: {"type":"object"');
    expect(unknown).toMatchObject({ is_error: true });
    expect(String(unknown!.content)).toContain("Unknown tool 'mcp__demo__nope'. Find the exact name with mcp_search.");
  });

  it("splits Korean into two-letter terms so particles do not block a match", () => {
    expect(searchTerms("결함을 조회")).toEqual(["결함", "함을", "조회"]);
    expect(searchTerms("listIssues v2")).toEqual(["list", "issues", "v2"]);
  });
});

describe("long MCP results", () => {
  it("shows the head and saves the full text inside the sandbox", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "big1", name: "mcp__demo__rows", arguments: {} }] }, { text: "ok" });
    const res = await h.stream({ input: "rows" });
    const content = String(ofType(res.events, "response.tool_result")[0]!.data.content);
    expect(content.startsWith("row 0\nrow 1\n")).toBe(true);
    expect(content).not.toContain("row 9999");
    expect(content).toContain("Full result: /tmp/pi-mcp-big1.txt]");
    const write = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.fsWrite && c.body.path === "/tmp/pi-mcp-big1.txt");
    expect(Buffer.from(String(write!.body.content), "base64").toString("utf8")).toMatch(/^row 0\n[\s\S]*\nrow 9999$/);
  });
});

describe("MCP image results", () => {
  it("replaces decompression-bomb images from MCP results with a notice before pi decodes them", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "img1", name: "mcp__demo__picture", arguments: { bomb: true } }] },
      { toolCalls: [{ id: "img2", name: "mcp__demo__picture", arguments: {} }] },
      { text: "done" },
    );
    const before = h.llm.requests.length;
    const res = await h.stream({ input: "pictures" });
    const [bomb, ok] = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(String(bomb!.content)).toContain("Image omitted (demo/picture)");
    expect(String(bomb!.content)).toContain("20000x20000");
    expect(ok!.content).toBe("[image]");
    expect(last(res.events).type).toBe("response.completed");
    // 폭탄 이미지는 모델 요청에도 들어가지 않는다
    expect(JSON.stringify(h.llm.requests.slice(before))).not.toContain(bombPng().toString("base64").slice(0, 200));
  });
});

describe("MCP inside the sandbox", () => {
  it("spawns the stdio server through sandboxd attach with metadata-rendered env", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "s1", name: "mcp__local__whoami", arguments: {} }] }, { text: "done" });
    const res = await h.stream({ input: "who", metadata: { thread_id: "t-9", ignored: "x" } });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(false);
    expect(String(result.content)).toContain("thread=t-9");
    expect(String(result.content)).toContain(h.sandbox.workspaceOf("alice"));
    const sessionId = /^resp_(.+)_\d+$/.exec((last(res.events).data.response as any).id)![1];
    const attach = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.attach && c.sid === sessionId)!;
    expect(attach.user).toBe("alice");
    // 시스템 전용 PATH와 하이재킹 방지 env가 기본으로 붙는다
    expect(attach.body.env).toEqual({ PATH: SANDBOX_SYSTEM_PATH, PYTHONNOUSERSITE: "1", NODE_OPTIONS: "", THREAD_ID: "t-9" });
    expect(attach.body.argv).toEqual([process.execPath, stdioServer]);
  });

  it("closes sandbox MCP processes on session teardown and reconnects on the next turn", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "s2", name: "mcp__local__echo", arguments: { text: "a" } }] }, { text: "one" });
    const first = await h.post({ input: "echo", metadata: { thread_id: "t-1" } });
    const sessionId = /^resp_(.+)_1$/.exec(first.json.id)![1]!;
    const attachesBefore = h.sandbox.calls.filter((c) => c.route === SANDBOXD_ROUTES.attach).length;
    await h.gateway.hub.evict(sessionId);
    h.llm.enqueue({ toolCalls: [{ id: "s3", name: "mcp__local__echo", arguments: { text: "b" } }] }, { text: "two" });
    const second = await h.post({ input: "echo again", previous_response_id: first.json.id, metadata: { thread_id: "t-1" } });
    expect(second.status).toBe(200);
    const attachesAfter = h.sandbox.calls.filter((c) => c.route === SANDBOXD_ROUTES.attach).length;
    expect(attachesAfter).toBe(attachesBefore + 1);
  });
});

describe("sandbox MCP plugin integration", () => {
  let p: Harness;
  beforeAll(async () => {
    p = await startHarness({
      // thread_id를 allowlist에서 뺀 gateway: metadata가 와도 템플릿에 들어가지 않아야 한다
      env: { MCP_METADATA_KEYS: "" },
      sandboxServers: [
        McpServerConfig.parse({
          id: "plugin-srv",
          runIn: "sandbox",
          scope: "per-session",
          source: { kind: "plugin", pluginId: "demo@mkt", version: "1.0.0" },
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [stdioServer, "--data", "/workspace/.home/.plugin-data/mkt--demo/state"],
            env: { THREAD_ID: "{{metadata:thread_id}}", CLAUDE_PLUGIN_DATA: "/workspace/.home/.plugin-data/mkt--demo" },
          },
        }),
      ],
    });
  });
  afterAll(async () => {
    await p.close();
  });

  it("creates the plugin data directory in the sandbox before spawning the server", async () => {
    p.llm.enqueue({ toolCalls: [{ id: "pd1", name: "mcp__plugin-srv__whoami", arguments: {} }] }, { text: "done" });
    const before = p.llm.requests.length;
    const res = await p.stream({ input: "who", metadata: { thread_id: "t-blocked" } });
    // plugin 서버의 도구도 하나씩 선언하지 않는다. skill에 적힌 이름으로 바로 부르면 실행된다
    const names = (p.llm.requests[before]!.tools ?? []).map((t) => t.function.name);
    expect(names).toContain("mcp_call");
    expect(names).not.toContain("mcp__plugin-srv__whoami");
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(false);
    const routes = p.sandbox.calls.map((c) => c.route);
    const mkdirIndex = p.sandbox.calls.findIndex((c) => c.route === SANDBOXD_ROUTES.fsMkdir && c.body.path === "/workspace/.home/.plugin-data/mkt--demo");
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(mkdirIndex).toBeLessThan(routes.indexOf(SANDBOXD_ROUTES.attach));
    expect(existsSync(join(p.sandbox.workspaceOf("alice"), ".home/.plugin-data/mkt--demo"))).toBe(true);
    // MCP_METADATA_KEYS에 없는 metadata는 템플릿에 들어가지 않는다
    expect(String(result.content)).toContain("thread=");
    expect(String(result.content)).not.toContain("t-blocked");
  });

  it("pluginDataDirs finds every referenced plugin data dir once", () => {
    expect(
      pluginDataDirs(["/workspace/.home/.plugin-data/a--b/x", "--out=/workspace/.home/.plugin-data/a--b", "/workspace/.home/.plugin-data/c--d"]),
    ).toEqual(["/workspace/.home/.plugin-data/a--b", "/workspace/.home/.plugin-data/c--d"]);
    expect(pluginDataDirs(["/workspace/other", "node"])).toEqual([]);
  });
});

describe("sandbox MCP tool lists are never shared between users", () => {
  let u: Harness;
  beforeAll(async () => {
    u = await startHarness({
      sandboxServers: [
        McpServerConfig.parse({
          id: "peruser",
          runIn: "sandbox",
          scope: "per-user",
          transport: { type: "stdio", command: process.execPath, args: [stdioServer], env: { EXTRA_TOOL: "tool_for_{{user}}" } },
        }),
      ],
    });
  });
  afterAll(async () => {
    await u.close();
  });

  it("lists each user's tools from that user's own sandbox", async () => {
    const search = (id: string) => ({ toolCalls: [{ id, name: "mcp_search", arguments: { query: "tool for", limit: 20 } }] });
    u.llm.enqueue(search("pu1"), { text: "ok" });
    const alice = await u.stream({ input: "alice lists" });
    expect(String(ofType(alice.events, "response.tool_result")[0]!.data.content)).toContain("mcp__peruser__tool_for_alice");
    u.llm.enqueue(search("pu2"), { text: "ok" });
    const bob = await u.stream({ input: "bob lists" }, { key: BOB_KEY });
    const bobTools = String(ofType(bob.events, "response.tool_result")[0]!.data.content);
    expect(bobTools).toContain("mcp__peruser__tool_for_bob");
    expect(bobTools).not.toContain("mcp__peruser__tool_for_alice");
    const bobAttach = u.sandbox.calls.filter((c) => c.route === SANDBOXD_ROUTES.attach && c.user === "bob");
    expect(bobAttach.length).toBeGreaterThan(0);
  });
});

describe("sandbox MCP command resolution", () => {
  const stub = (existing: string[]) => ({
    stat: async (path: string) => (existing.includes(path) ? { exists: true, kind: "file" as const } : { exists: false }),
  });

  it("resolves bare commands only from system directories", async () => {
    await expect(resolveSandboxCommand(stub(["/usr/bin/node"]), "node")).resolves.toBe("/usr/bin/node");
    // /usr/local/bin이 /usr/bin보다 먼저다
    await expect(resolveSandboxCommand(stub(["/usr/local/bin/node", "/usr/bin/node"]), "node")).resolves.toBe("/usr/local/bin/node");
    // workspace에 심은 실행 파일은 후보가 아니다
    await expect(resolveSandboxCommand(stub(["/workspace/.home/.local/bin/node"]), "node")).rejects.toThrow("not found in the sandbox system PATH");
    // 경로로 준 명령은 그대로 쓴다
    await expect(resolveSandboxCommand(stub([]), "/opt/plugins/x/server")).resolves.toBe("/opt/plugins/x/server");
    // 셸을 거치지 않으므로 위험하지는 않지만, 이름에 이상한 문자가 있으면 거부한다
    await expect(resolveSandboxCommand(stub([]), "node;rm")).rejects.toThrow("invalid MCP server command");
  });
});

describe("MCP tool cache", () => {
  it("drops expired entries when a new one is stored, so per-session keys do not pile up", async () => {
    const cache = new McpToolCache(50);
    const size = () => (cache as unknown as { entries: Map<string, unknown> }).entries.size;
    for (const session of ["s1", "s2", "s3"]) cache.set(`sandbox:local:h:alice:${session}`, []);
    expect(size()).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 60));
    cache.set("sandbox:local:h:alice:s4", []);
    expect(size()).toBe(1);
  });
});
