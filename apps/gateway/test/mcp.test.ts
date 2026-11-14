import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpServerConfig, SANDBOXD_ROUTES } from "@pi-gateway/shared";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachedStdioTransport, McpToolCache, pluginDataDirs, resolveSandboxCommand, SANDBOX_SYSTEM_PATH, wholeSseEvents } from "../src/mcp-client/connections.js";
import { createMcpProxyTools, searchTerms } from "../src/mcp-client/proxy.js";
import { bombPng, tinyPng } from "./fixtures/images.js";
import { BOB_KEY, type Harness, last, ofType, startHarness } from "./helpers.js";

const stdioServer = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));

const FILE_BYTES = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
/** What the `stage` tool of the demo server received, call by call. */
const staged: Record<string, unknown>[] = [];
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

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
        {
          name: "stage",
          description: "stage files",
          inputSchema: {
            type: "object",
            properties: {
              note: { type: "string" },
              files: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    field: { type: "string" },
                    file: { type: "object", "x-workspace-file": true, description: "The file to stage." },
                  },
                  required: ["file"],
                },
              },
            },
            required: ["files"],
          },
          handler: (args) => {
            staged.push(args);
            return { text: `staged ${(args.files as unknown[]).length}` };
          },
        },
        {
          name: "file",
          handler: (args) => ({
            content: [
              { type: "text", text: "here is the file" },
              {
                type: "resource",
                resource: {
                  uri: String(args.uri ?? "artifact://a1/report.bin"),
                  mimeType: String(args.mime ?? "application/octet-stream"),
                  blob: String(args.blob ?? (args.mime ? tinyPng() : FILE_BYTES).toString("base64")),
                  ...(args.meta ? { _meta: args.meta } : {}),
                },
              },
            ],
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

  it("accepts the tool names skills use: Claude Code plugin names and bare MCP tool names", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "al1", name: "mcp_call", arguments: { name: "mcp__plugin_demo-plugin_demo__echo", arguments: { text: "cc" } } }] },
      { toolCalls: [{ id: "al2", name: "mcp_call", arguments: { name: "fail" } }] },
      { toolCalls: [{ id: "al3", name: "mcp_call", arguments: { name: "echo", arguments: { text: "x" } } }] },
      { text: "ok" },
    );
    const res = await h.stream({ input: "alias calls" });
    const [cc, bare, ambiguous] = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(String(cc!.content)).toContain("echo:cc");
    expect(bare).toMatchObject({ is_error: true, content: "upstream refused" });
    // 두 서버에 같은 이름이 있으면 고르지 않고 후보를 돌려준다
    expect(String(ambiguous!.content)).toContain("'echo' matches several tools: mcp__demo__echo, mcp__local__echo.");
  });

  it("splits Korean into two-letter terms so particles do not block a match", () => {
    expect(searchTerms("결함을 조회")).toEqual(["결함", "함을", "조회"]);
    expect(searchTerms("listIssues v2")).toEqual(["list", "issues", "v2"]);
  });

  it("lists a server whose tool list failed, and fetches it again when the model needs it", async () => {
    const late: ToolDefinition = {
      name: "mcp__late__ping",
      label: "late/ping",
      description: "ping the late service",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
    };
    let retries = 0;
    const [search, call] = createMcpProxyTools([], [{ id: "late", displayName: "Late" }], {
      failed: new Set(["late"]),
      retryFailed: async () => (retries++ === 0 ? [late] : []),
    });
    expect(search!.description).toContain("- late (Late)");
    const result = await call!.execute("c1", { name: "mcp__late__ping", arguments: {} }, undefined, undefined, undefined as never);
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    const found = await search!.execute("s1", { query: "ping" }, undefined, undefined, undefined as never);
    expect(JSON.stringify(found.content)).toContain("## mcp__late__ping");
    expect(retries).toBe(2);
  });
});

describe("mcp_search with System One", () => {
  it("lets the decision model pick among all tools, and searches with BM25 when that call fails", async () => {
    await h.gateway.models.setSystemOne({ baseUrl: h.llm.url, apiKey: "search-key", headers: {}, id: "d3-ultra", compare: false });
    const searched = async (query: string) => {
      h.llm.enqueue({ toolCalls: [{ id: "d1", name: "mcp_search", arguments: { query, limit: 2 } }] }, { text: "ok" });
      const res = await h.stream({ input: "find" });
      return String(ofType(res.events, "response.tool_result")[0]!.data.content).match(/^## .+$/gm);
    };
    try {
      // BM25로는 echo가 맞는 질의지만 System One이 고른 순서를 따른다
      h.llm.setDecision(() => ({ mcp__demo__rows: 0.7, mcp__demo__echo: 0.2, mcp__demo__fail: 0.1 }));
      expect(await searched("echo back")).toEqual(["## mcp__demo__rows", "## mcp__demo__echo"]);
      const asked = h.llm.decisions.at(-1)!;
      expect(asked.headers.authorization).toBe("Bearer search-key");
      expect(asked.body).toMatchObject({ model: "d3-ultra", state: { query: "echo back" } });
      const { choice } = asked.body.questions;
      expect(choice!.type).toBe("choice");
      expect(choice!.criteria).toMatchObject({ mcp__demo__echo: "echo back", mcp__demo__fail: "MCP tool fail from server demo" });
      expect(Object.keys(choice!.criteria)).toContain("mcp__local__echo");

      h.llm.setDecision(null);
      const before = h.llm.decisions.length;
      expect((await searched("echo back"))![0]).toBe("## mcp__demo__echo");
      expect(h.llm.decisions.length).toBe(before + 1);
    } finally {
      await h.gateway.models.setSystemOne(null);
    }
  });
});

describe("read_only sessions", () => {
  it("drop the tools that change the sandbox or run commands, for the whole session", async () => {
    h.llm.enqueue({ text: "ok" }, { text: "ok again" });
    const names = () => (h.llm.requests.at(-1)!.tools ?? []).map((t) => t.function.name);
    const res = await h.post({ input: "look only", read_only: true });
    expect(res.status).toBe(200);
    expect(names()).toEqual(expect.arrayContaining(["read", "ls", "find", "grep", "mcp_search", "mcp_call"]));
    for (const tool of ["write", "edit", "bash"]) expect(names()).not.toContain(tool);
    // broker 서버는 남고, sandbox 안에서 명령을 띄우는 sandbox 서버는 빠진다
    const search = h.llm.requests.at(-1)!.tools!.find((t) => t.function.name === "mcp_search")!.function.description;
    expect(search).toContain("- demo");
    expect(search).not.toContain("- local");

    // 보내지 않으면 그대로 이어가고, 다른 값이면 400
    const next = await h.post({ input: "again", previous_response_id: res.json.id });
    expect(next.status).toBe(200);
    expect(names()).not.toContain("bash");
    expect((await h.post({ input: "x", previous_response_id: next.json.id, read_only: false })).status).toBe(400);
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

describe("MCP file results", () => {
  const callFile = async (id: string, args: Record<string, unknown>, body: Record<string, unknown> = {}) => {
    h.llm.enqueue({ toolCalls: [{ id, name: "mcp__demo__file", arguments: args }] }, { text: "ok" });
    const res = await h.stream({ input: "file", ...body });
    const sessionId = /^resp_(.+)_\d+$/.exec((last(res.events).data.response as any).id)![1]!;
    return { result: ofType(res.events, "response.tool_result")[0]!.data, sessionId, id: (last(res.events).data.response as any).id as string };
  };
  const filesOf = (sessionId: string) => {
    const dir = join(h.sandbox.workspaceOf("alice"), "artifacts", sessionId);
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it("saves a binary resource into the session's folder and gives the model the path, size and checksum", async () => {
    const digest = sha256(FILE_BYTES);
    const first = await callFile("f1", { meta: { size: FILE_BYTES.length, sha256: digest.toUpperCase() } });
    const path = `/workspace/artifacts/${first.sessionId}/report-${digest.slice(0, 8)}.bin`;
    expect(first.result.is_error).toBe(false);
    expect(first.result.content).toBe(
      `here is the file\nSaved to the workspace: ${JSON.stringify({ saved_path: path, size: 10, sha256: digest, mime: "application/octet-stream", truncated: false })}`,
    );
    expect(readFileSync(join(h.sandbox.workspaceOf("alice"), "artifacts", first.sessionId, `report-${digest.slice(0, 8)}.bin`))).toEqual(FILE_BYTES);

    // 같은 내용을 다시 받으면 같은 경로다. 다른 세션은 다른 폴더에 둔다.
    h.llm.enqueue({ toolCalls: [{ id: "f2", name: "mcp__demo__file", arguments: {} }] }, { text: "ok" });
    const again = await h.stream({ input: "again", previous_response_id: first.id });
    expect(String(ofType(again.events, "response.tool_result")[0]!.data.content)).toContain(path);
    expect(filesOf(first.sessionId)).toEqual([`report-${digest.slice(0, 8)}.bin`]);
    const other = await callFile("f3", {});
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(String(other.result.content)).toContain(`/workspace/artifacts/${other.sessionId}/report-`);
  });

  it("keeps the file inside the folder whatever the uri says", async () => {
    for (const uri of ["artifact://a1/..%2F..%2F.home%2F.bashrc", "artifact://a1/..", "/etc/passwd/"]) {
      const { result, sessionId } = await callFile("f4", { uri });
      expect(String(result.content)).toContain(`"saved_path":"/workspace/artifacts/${sessionId}/artifact-${sha256(FILE_BYTES).slice(0, 8)}.bin"`);
      expect(filesOf(sessionId)).toEqual([`artifact-${sha256(FILE_BYTES).slice(0, 8)}.bin`]);
    }
  });

  it("fails the call and saves nothing when the bytes are damaged or differ from what the server declared", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ blob: FILE_BYTES.toString("base64").slice(0, -3) }, /not saved: the transfer was truncated or is not valid base64/],
      [{ meta: { size: 11 } }, /not saved: received 10 bytes, but the server declared 11/],
      [{ meta: { sha256: "0".repeat(64) } }, /not saved: the sha256 of the received bytes does not match/],
    ];
    for (const [args, message] of cases) {
      const { result, sessionId } = await callFile("f5", args);
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toMatch(message);
      expect(String(result.content)).not.toContain("artifact://");
      expect(filesOf(sessionId)).toEqual([]);
    }
  });

  it("saves an image resource and still shows it to the model", async () => {
    const { result, sessionId } = await callFile("f6", { uri: "artifact://a2/chart.png", mime: "image/png" });
    expect(String(result.content)).toMatch(/Saved to the workspace: .*chart-[0-9a-f]{8}\.png.*\n\[image\]$/);
    expect(filesOf(sessionId)).toHaveLength(1);
  });

  it("does not write to the workspace in a read_only session", async () => {
    const { result, sessionId } = await callFile("f7", {}, { read_only: true });
    expect(String(result.content)).toContain("[binary resource");
    expect(filesOf(sessionId)).toEqual([]);
  });
});

describe("MCP file arguments", () => {
  const ws = () => h.sandbox.workspaceOf("alice");
  const put = (rel: string, content: Buffer | string) => {
    mkdirSync(join(ws(), rel, ".."), { recursive: true });
    writeFileSync(join(ws(), rel), content);
  };
  const stage = async (id: string, files: unknown[], body: Record<string, unknown> = {}) => {
    h.llm.enqueue({ toolCalls: [{ id, name: "mcp_call", arguments: { name: "mcp__demo__stage", arguments: { note: "n", files } } }] }, { text: "ok" });
    const before = h.llm.requests.length;
    const res = await h.stream({ input: "stage", ...body });
    return { result: ofType(res.events, "response.tool_result")[0]!.data, llm: JSON.stringify(h.llm.requests.slice(before)) };
  };

  it("shows a file argument to the model as a workspace path, not as the server's object", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "fa0", name: "mcp_search", arguments: { query: "stage files" } }] }, { text: "ok" });
    const res = await h.stream({ input: "find" });
    const found = String(ofType(res.events, "response.tool_result")[0]!.data.content);
    expect(found).toContain("## mcp__demo__stage");
    expect(found).toContain('"file":{"type":"string","description":"The file to stage. Absolute path of a file under /workspace (pdf, docx,');
    expect(found).not.toContain("x-workspace-file");
    // A tool without a file argument keeps its schema as the server gave it.
    h.llm.enqueue({ toolCalls: [{ id: "fa0b", name: "mcp_search", arguments: { query: "echo back" } }] }, { text: "ok" });
    const echo = String(ofType((await h.stream({ input: "find" })).events, "response.tool_result")[0]!.data.content);
    expect(echo).toContain('Parameters: {"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}');
  });

  it("sends the files of the paths the model named: name, type, size, checksum and the bytes — and the model never sees the bytes", async () => {
    const png = tinyPng();
    put("out/capture.png", png);
    put("out/map 1.csv", "a,b\n1,2\n");
    staged.length = 0;
    const { result, llm } = await stage("fa1", [
      { field: "capture", file: "/workspace/out/capture.png" },
      { field: "maps", file: "out/map 1.csv" },
    ]);
    expect(result).toMatchObject({ is_error: false, content: "staged 2" });
    expect(staged).toHaveLength(1);
    const [capture, map] = (staged[0]!.files as { field: string; file: Record<string, unknown> }[]).map((f) => ({ field: f.field, ...f.file }));
    expect(capture).toEqual({ field: "capture", filename: "capture.png", mimeType: "image/png", size: png.length, sha256: sha256(png), data: png.toString("base64") });
    expect(map).toMatchObject({ field: "maps", filename: "map 1.csv", mimeType: "text/csv", size: 8, sha256: sha256(Buffer.from("a,b\n1,2\n")) });
    // Arguments nobody marked are passed as they are.
    expect(staged[0]!.note).toBe("n");
    // What the model wrote and reads back is the path.
    expect(llm).toContain("/workspace/out/capture.png");
    expect(llm).not.toContain(png.toString("base64").slice(0, 40));
  });

  it("refuses a path that is not a regular, non-empty, allowed file of the workspace, and makes no call", async () => {
    put("out/empty.png", "");
    put("out/run.exe", "MZ");
    mkdirSync(join(ws(), "out", "dir.png"), { recursive: true });
    symlinkSync("/etc/hostname", join(ws(), "out", "link.txt"));
    symlinkSync("/etc", join(ws(), "out", "etc"));
    put("out/ok.txt", "ok");
    const cases: [unknown, RegExp][] = [
      ["/etc/hostname.txt", /is outside \/workspace/],
      ["out/../../etc/hostname.txt", /is outside \/workspace/],
      ["/tmp/x.txt", /is outside \/workspace/],
      ["out/missing.png", /does not exist/],
      ["out/empty.png", /is empty/],
      ["out/run.exe", /cannot be sent: only \.pdf/],
      ["out/dir.png", /is not a regular file/],
      ["out/link.txt", /goes through a symbolic link \(\/workspace\/out\/link\.txt\)/],
      ["out/etc/hostname.txt", /goes through a symbolic link \(\/workspace\/out\/etc\)/],
      // The model's schema says "a path": an object (file content typed by hand) fails validation before anything is read.
      [{ data: "AAAA" }, /Validation failed for tool/],
    ];
    staged.length = 0;
    for (const [file, message] of cases) {
      // One good file next to the bad one: nothing of the call goes out.
      const { result } = await stage("fa2", [{ field: "a", file: "out/ok.txt" }, { field: "b", file }]);
      expect(result.is_error).toBe(true);
      expect(String(result.content)).toMatch(message);
    }
    const { result } = await stage("fa3", Array.from({ length: 11 }, () => ({ file: "out/ok.txt" })));
    expect(String(result.content)).toContain("At most 10 files can be sent in one call.");
    expect(staged).toEqual([]);
  });

  it("does not send workspace files from a read_only session", async () => {
    put("out/ok.txt", "ok");
    staged.length = 0;
    const { result } = await stage("fa4", [{ file: "out/ok.txt" }], { read_only: true });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("This session is read-only: files of the workspace cannot be sent.");
    expect(staged).toEqual([]);
  });
});

describe("wholeSseEvents", () => {
  const chunksOf = async (parts: string[], contentType: string) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(Buffer.from(part));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const chunk of wholeSseEvents(new Response(body, { headers: { "content-type": contentType } })).body!) out.push(Buffer.from(chunk).toString());
    return out;
  };

  it("hands each SSE event over in one chunk, and a small event as soon as it ends", async () => {
    const parts = ['event: message\ndata: {"a"', ":1}\n", "\n", "data: progress\n\n", "data: big\r\n\r", "\n", "data: cut off"];
    expect(await chunksOf(parts, "text/event-stream")).toEqual(['event: message\ndata: {"a":1}\n\n', "data: progress\n\n", "data: big\r\n\r\n", "data: cut off"]);
    // SSE가 아니면 건드리지 않는다
    expect(await chunksOf(['{"a"', ":1}\n\n", "x"], "application/json")).toEqual(['{"a"', ":1}\n\n", "x"]);
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

describe("attachedStdioTransport", () => {
  /** sandboxd attach 흉내. exit는 테스트가 직접 알린다. */
  const fakeProcess = () => {
    const p = {
      push: (_chunk: Buffer) => {},
      stderr: (_chunk: Buffer) => {},
      exit: (_info: { exitCode: number | null; signal: string | null; error?: string }) => {},
      closed: 0,
      written: [] as string[],
    };
    const spawn = async () => ({
      write: (data: Buffer | string) => void p.written.push(String(data)),
      onStdout: (l: (chunk: Buffer) => void) => (p.push = l),
      onStderr: (l: (chunk: Buffer) => void) => (p.stderr = l),
      onExit: (l: typeof p.exit) => (p.exit = l),
      close: () => void p.closed++,
    });
    return { p, spawn };
  };

  it("chunk 경계에서 잘린 UTF-8 글자를 깨뜨리지 않고, 메시지를 한 줄로 쓰고, stderr를 넘긴다", async () => {
    const { p, spawn } = fakeProcess();
    const stderr: string[] = [];
    const transport = attachedStdioTransport(spawn, (text) => stderr.push(text));
    const got: unknown[] = [];
    transport.onMessage((m) => got.push(m));
    await transport.start();
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "n", params: { text: "한글" } })}\n`);
    const cut = bytes.indexOf(Buffer.from("한")) + 1; // 글자 중간
    p.push(bytes.subarray(0, cut));
    p.push(bytes.subarray(cut));
    expect(got).toEqual([{ jsonrpc: "2.0", method: "n", params: { text: "한글" } }]);
    await transport.send({ jsonrpc: "2.0", method: "m" });
    expect(p.written).toEqual(['{"jsonrpc":"2.0","method":"m"}\n']);
    p.stderr(Buffer.from("warn"));
    expect(stderr).toEqual(["warn"]);
  });

  it("오류로 끝나면 오류를 알린 뒤 닫히고, 닫을 때는 exit 알림을 기다리지 않는다", async () => {
    const failed = fakeProcess();
    const t1 = attachedStdioTransport(failed.spawn, () => {});
    const events: string[] = [];
    t1.onError((e) => events.push(`error ${e.message}`));
    t1.onClose(() => events.push("close"));
    await t1.start();
    failed.p.exit({ exitCode: null, signal: null, error: "attach failed" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["error attach failed", "close"]);

    const quiet = fakeProcess();
    const t2 = attachedStdioTransport(quiet.spawn, () => {});
    let closed = false;
    t2.onClose(() => (closed = true));
    await t2.start();
    await t2.close();
    expect(quiet.p.closed).toBeGreaterThan(0);
    expect(closed).toBe(true);
  });
});
