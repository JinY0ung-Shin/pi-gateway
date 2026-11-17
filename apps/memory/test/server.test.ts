import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { userKey } from "@pi-gateway/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { piClient, startTestBroker, type TestBroker, textOf } from "../../mcp-broker/test/helpers.js";
import { createMemoryService } from "../src/app.js";
import { TOOL_LIST } from "../src/tools.js";

const API_KEY = randomBytes(32).toString("hex");

let dataDir: string;
let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-server-test-"));
  app = createMemoryService({ host: "127.0.0.1", port: 0, dataDir, apiKey: API_KEY }, { log: pino({ level: "silent" }) });
  url = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 키를 가진 쪽이 주인을 URL에 넣어 붙는다 */
async function connect(owner: string, key = API_KEY): Promise<McpClient> {
  const client = new McpClient({ name: "memory-test", version: "0.0.0", requestTimeoutMs: 30_000 });
  await client.connect(new StreamableHttpTransport({ url: `${url}/mcp/${owner}`, openGetStream: false, authProvider: { token: async () => key } }));
  return client;
}

const hashOf = (text: string) => /^hash: ([0-9a-f]{64})$/m.exec(text)![1]!;

describe("memory 서비스 (MCP)", () => {
  it("도구 여섯 개를 내놓고, 어느 도구도 주인을 인자로 받지 않는다", async () => {
    const client = await connect("alice");
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "list", "read", "write", "edit", "delete"]);
    const known = new Set(["query", "limit", "prefix", "path", "offset", "content", "hash", "old_text", "new_text"]);
    for (const tool of TOOL_LIST) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      expect(Object.keys(schema.properties ?? {}).filter((p) => !known.has(p)), tool.name).toEqual([]);
      expect(schema.additionalProperties, tool.name).toBe(false);
    }
    // 주인처럼 보이는 인자를 끼워 넣어도 URL의 주인 wiki만 본다.
    await client.callTool("write", { path: "mine.md", content: "alice's", owner: "bob", user: "bob" });
    expect(textOf(await client.callTool("list", { owner: "bob" }))).toContain("- mine.md");
    await client.close();
    const bob = await connect("bob");
    expect(textOf(await bob.callTool("list", {}))).not.toContain("mine.md");
    await bob.close();
  });

  it("키를 가진 쪽이 주인을 지정해 쓰고, 새 연결에서 찾아 읽고, 고치고, 지운다", async () => {
    const first = await connect("carol");
    const created = await first.callTool("write", { path: "people/dana.md", content: "---\ntitle: Dana\ntags: [team]\n---\nDana owns the billing service." });
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toMatch(/^Created people\/dana\.md\./);
    await first.close();

    const second = await connect("carol");
    const found = await second.callTool("search", { query: "billing" });
    expect(textOf(found)).toContain("- people/dana.md [team]: Dana");
    const read = await second.callTool("read", { path: "people/dana.md" });
    expect(textOf(read)).toContain("Dana owns the billing service.");
    const edited = await second.callTool("edit", { path: "people/dana.md", old_text: "billing", new_text: "payments", hash: hashOf(textOf(read)) });
    expect(edited.isError).toBeFalsy();
    // 고친 뒤에는 읽을 때의 hash로 지울 수 없다.
    const stale = await second.callTool("delete", { path: "people/dana.md", hash: hashOf(textOf(read)) });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/^stale: /);
    const deleted = await second.callTool("delete", { path: "people/dana.md", hash: hashOf(textOf(edited)) });
    expect(textOf(deleted)).toBe("Deleted people/dana.md.");
    expect(textOf(await second.callTool("list", {}))).toBe("This wiki has no notes yet.");
    await second.close();
  });

  it("거절은 빈 결과가 아니라 오류 결과로 돌아온다", async () => {
    const client = await connect("erin");
    const outside = await client.callTool("write", { path: "../../etc/passwd.md", content: "x" });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/^invalid_path: /);
    const missing = await client.callTool("read", { path: "none.md" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^not_found: /);
    const badArgs = await client.callTool("write", { path: "a.md" });
    expect(badArgs.isError).toBe(true);
    await client.close();
  });

  it("저장소를 읽지 못하면 빈 결과가 아니라 오류 결과다", async () => {
    // 주인 폴더 자리에 파일을 놓아 읽기를 실패시킨다.
    mkdirSync(join(dataDir, "wikis"), { recursive: true });
    writeFileSync(join(dataDir, "wikis", userKey("ivan")), "not a folder");
    const client = await connect("ivan");
    for (const [name, args] of [["list", {}], ["search", { query: "x" }]] as const) {
      const result = await client.callTool(name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/^internal: /);
    }
    await client.close();
  });

  it("키가 없거나 틀리면 401, 주인이 사용자 id 형식이 아니면 400이다", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(`${url}/mcp/alice`, { method: "POST", headers, body })).status).toBe(401);
    expect((await fetch(`${url}/mcp/alice`, { method: "POST", headers: { ...headers, authorization: `Bearer ${"x".repeat(64)}` }, body })).status).toBe(401);
    expect((await fetch(`${url}/mcp/-bad`, { method: "POST", headers: { ...headers, authorization: `Bearer ${API_KEY}` }, body })).status).toBe(400);
    // 사용자 id는 128자까지다.
    expect((await fetch(`${url}/mcp/${"a".repeat(128)}`, { method: "POST", headers: { ...headers, authorization: `Bearer ${API_KEY}` }, body })).status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it("라우터가 같은 경로로 풀어 주는 다른 표기로도 키 없이는 닿지 못한다", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: { path: "pwn.md", content: "x" } } });
    const { hostname, port } = new URL(url);
    /** 요청 줄에 `target`을 그대로 실어 보낸다 (fetch는 경로를 정리해 버린다). */
    const send = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { hostname, port, method: "POST", path: target, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    for (const target of ["/%6dcp/mallory", "/%6Dcp/mallory", "http://x/mcp/mallory", "/mcp/mallory?x=1", "/mcp/mallory/", "/nope"]) {
      expect(await send(target), target).toBe(401);
    }
    const client = await connect("mallory");
    expect(textOf(await client.callTool("list", {}))).toBe("This wiki has no notes yet.");
    await client.close();
  });

  it("긴 노트와 긴 목록도 gateway가 자르는 크기(50KB) 아래로 나눠 준다", async () => {
    const client = await connect("frank");
    const content = Array.from({ length: 6000 }, (_, i) => `line ${i} of a long note`).join("\n");
    const written = await client.callTool("write", { path: "long.md", content });
    const first = textOf(await client.callTool("read", { path: "long.md" }));
    expect(Buffer.byteLength(first)).toBeLessThan(50 * 1024);
    const next = Number(/MORE REMAINS: read again with offset (\d+) and this hash\./.exec(first)![1]);
    const second = textOf(await client.callTool("read", { path: "long.md", offset: next, hash: hashOf(first) }));
    expect(second).toContain(`part: bytes ${next}–`);
    expect(hashOf(second)).toBe(hashOf(textOf(written)));
    // 앞부분만 본 채로 통째로 바꾸려 하면 거절한다.
    const replaced = await client.callTool("write", { path: "long.md", content: "short", hash: hashOf(first) });
    expect(replaced.isError).toBe(true);
    expect(textOf(replaced)).toMatch(/^too_large: /);

    for (let i = 0; i < 150; i++) await client.callTool("write", { path: `${"folder-with-a-long-name/".repeat(12)}note-${i}.md`, content: "x" });
    const listed = textOf(await client.callTool("list", {}));
    expect(Buffer.byteLength(listed)).toBeLessThan(50 * 1024);
    expect(listed).toMatch(/^151 note\(s\):/);
    expect(listed).toMatch(/…and \d+ more \(in path order\)\. Narrow the list with `prefix`\.$/);
    await client.close();
  });
});

describe("mcp-broker를 거쳐 (pi 단독 사용)", { timeout: 120_000 }, () => {
  let tb: TestBroker;

  beforeAll(async () => {
    tb = await startTestBroker();
    // 운영 문서의 등록 예와 같은 모양: URL 경로의 {{user}}가 주인을 정하고, 키는 broker의 비밀값이다.
    await tb.addHttpServer("memory", `${url}/mcp/{{user}}`, { headers: { Authorization: "Bearer {{secret:MEMORY_API_KEY}}" } });
    expect((await tb.admin("PUT", "/admin/servers/memory/secrets/MEMORY_API_KEY", { value: API_KEY })).status).toBe(204);
  });
  afterAll(async () => {
    await tb?.close();
  });

  it("한 세션에서 쓴 노트를 같은 사용자의 새 세션이 찾아 읽고, 다른 사용자에게는 보이지 않는다", async () => {
    const session1 = await piClient(tb, "memory", { sub: "alice", sid: "s1" });
    const written = await session1.callTool("write", { path: "prefs/reports.md", content: "Alice wants reports as tables." });
    expect(written.isError).toBeFalsy();
    await session1.close();

    const session2 = await piClient(tb, "memory", { sub: "alice", sid: "s2" });
    expect(textOf(await session2.callTool("search", { query: "tables" }))).toContain("- prefs/reports.md");
    expect(textOf(await session2.callTool("read", { path: "prefs/reports.md" }))).toContain("Alice wants reports as tables.");
    await session2.close();

    const other = await piClient(tb, "memory", { sub: "bob", sid: "s3" });
    expect(textOf(await other.callTool("list", {}))).toBe("This wiki has no notes yet.");
    expect((await other.callTool("read", { path: "prefs/reports.md" })).isError).toBe(true);
    await other.close();
  });
});
