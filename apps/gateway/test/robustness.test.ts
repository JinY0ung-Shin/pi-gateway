import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jwtSecretBytes, McpServerConfig } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SandboxClient, SandboxError } from "../src/sandbox/client.js";
import { TurnLimiter } from "../src/sessions/limiter.js";
import { BOB_KEY, type Harness, last, ofType, SERVICE_KEY, startHarness } from "./helpers.js";

/** core 리뷰에서 나온 버그들의 회귀 테스트 */

const stdioServer = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sessionOf = (id: string) => /^resp_(.+)_\d+$/.exec(id)![1]!;

describe("1. a stalled sandbox attach cannot hang a turn", () => {
  it("SandboxClient.attach gives up when the process never starts", async () => {
    const http = createServer((_req, res) => res.writeHead(500).end());
    const wss = new WebSocketServer({ server: http, path: "/v1/attach" });
    wss.on("connection", () => {
      /* started를 보내지 않는다 */
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const client = new SandboxClient({ baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, jwtSecret: jwtSecretBytes("s".repeat(40)) });
    const t0 = Date.now();
    const err = await client.for("alice", "s1").attach({ argv: ["node"] }, undefined, 300).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
    wss.close();
    http.close();
  });

  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      fakeSandbox: { stallAttach: true },
      overrides: { mcpListTimeoutMs: 1500 },
      sandboxServers: [
        McpServerConfig.parse({ id: "stuck", runIn: "sandbox", scope: "per-session", transport: { type: "stdio", command: process.execPath, args: ["x.js"] } }),
      ],
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("the turn runs without the stalled server's tools after the list timeout", async () => {
    const t0 = Date.now();
    const res = await h.post({ input: "hi" });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    const names = (h.llm.requests.at(-1)!.tools ?? []).map((t) => t.function.name);
    expect(names.some((n) => n.startsWith("mcp__stuck__"))).toBe(false);
    expect(h.gateway.limiter.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("a client abort while the server is stalled frees the turn slot and the session lock", async () => {
    const ctrl = new AbortController();
    const p = fetch(`${h.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice-key-0123456789abcdef" },
      body: JSON.stringify({ input: "hi", stream: true }),
      signal: ctrl.signal,
    }).catch(() => null);
    await sleep(200);
    expect(h.gateway.limiter.stats().active).toBe(1);
    ctrl.abort();
    await p;
    let freed = false;
    for (let i = 0; i < 20 && !freed; i++) {
      await sleep(50);
      freed = h.gateway.limiter.stats().active === 0;
    }
    expect(freed).toBe(true);
  });
});

describe("2. MCP tools/call is only retried when the request was not dispatched", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      brokerServers: {
        jira: [
          { name: "create_issue", handler: () => ({ rpcError: { code: -32603, message: "upstream failed (ref abc)" } }) },
          { name: "flaky", notFoundOnce: true, handler: () => ({ text: "created once" }) },
        ],
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("a JSON-RPC error is not retried (the side effect may already have happened)", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "c1", name: "mcp__jira__create_issue", arguments: {} }] }, { text: "done" });
    const res = await h.stream({ input: "file a ticket" });
    expect(h.broker!.executions["jira/create_issue"]).toBe(1);
    expect(ofType(res.events, "response.tool_result")[0]!.data.is_error).toBe(true);
  });

  it("a session-expired (404) answer is retried once on a fresh connection", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "c2", name: "mcp__jira__flaky", arguments: {} }] }, { text: "done" });
    const res = await h.stream({ input: "flaky" });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result).toMatchObject({ is_error: false, content: "created once" });
    expect(h.broker!.executions["jira/flaky"]).toBe(1);
  });
});

describe("3. the turn limiter has no head-of-line blocking", () => {
  it("a user waiting on its own cap does not block other users while global slots are free", async () => {
    const lim = new TurnLimiter(4, 1, 100, 1500);
    const releaseA1 = await lim.acquire("alice");
    const a2 = lim.acquire("alice");
    const t0 = Date.now();
    const releaseB = await lim.acquire("bob");
    expect(Date.now() - t0).toBeLessThan(100);
    expect(lim.stats()).toEqual({ active: 2, queued: 1 });
    releaseB();
    releaseA1();
    (await a2)();
    expect(lim.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("close() rejects waiters and later acquires", async () => {
    const lim = new TurnLimiter(1, 1, 10, 5000);
    const r1 = await lim.acquire("a");
    const waiting = lim.acquire("b");
    lim.close(new Error("shutting down"));
    await expect(waiting).rejects.toThrow("shutting down");
    await expect(lim.acquire("c")).rejects.toThrow("shutting down");
    r1();
  });
});

describe("4. pi auto-retry does not duplicate streamed text", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ overrides: { piSettings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 20 } } } });
  });
  afterAll(async () => {
    await h.close();
  });

  it("stream: the failed attempt's item is closed as incomplete and dropped from the final output", async () => {
    h.llm.enqueue({ textChunks: ["Hello wor"], dropConnection: true }, { text: "Hello world" });
    const res = await h.stream({ input: "hi" });
    const completed = last(res.events);
    expect(completed.type).toBe("response.completed");
    const output = (completed.data.response as any).output;
    expect(output).toHaveLength(1);
    expect(output[0].content[0].text).toBe("Hello world");
    const done = ofType(res.events, "response.output_item.done").map((e) => (e.data.item as any).status);
    expect(done).toEqual(["incomplete", "completed"]);
    // 다시 시도한 항목은 버린 항목의 index를 다시 쓴다: 최종 output 배열의 위치와 같다
    const added = ofType(res.events, "response.output_item.added").map((e) => e.data.output_index);
    expect(added).toEqual([0, 0]);
    const finalDone = ofType(res.events, "response.output_item.done").at(-1)!.data;
    expect(finalDone.output_index).toBe(0);
    expect((finalDone.item as any).id).toBe(output[0].id);
  });

  it("non-stream: only the successful attempt's text is returned", async () => {
    h.llm.enqueue({ textChunks: ["The answer is 4"], dropConnection: true }, { text: "The answer is 42." });
    const res = await h.post({ input: "q" });
    expect(res.json.status).toBe("completed");
    expect(res.json.output.at(-1).content[0].text).toBe("The answer is 42.");
  });

  it("text from before the failed attempt (earlier tool round) is kept", async () => {
    h.llm.enqueue(
      { text: "Checking.", toolCalls: [{ id: "t1", name: "bash", arguments: { command: "echo hi" } }] },
      { textChunks: ["Partial ans"], dropConnection: true },
      { text: "Final answer." },
    );
    const res = await h.stream({ input: "work" });
    const output = (last(res.events).data.response as any).output;
    expect(output.map((o: any) => o.content[0].text)).toEqual(["Checking.", "Final answer."]);
    // 최종 항목들의 스트림 index가 output 배열 위치와 같다
    const doneById = new Map(ofType(res.events, "response.output_item.done").map((e) => [(e.data.item as any).id, e.data.output_index]));
    output.forEach((item: any, i: number) => expect(doneById.get(item.id)).toBe(i));
  });
});

describe("5. shutdown is prompt and rejects queued requests", () => {
  it("a queued request gets 503 and close() finishes quickly", async () => {
    const h = await startHarness({ env: { MAX_CONCURRENT_TURNS: "1", TURN_QUEUE_TIMEOUT_SECONDS: "30" } });
    h.llm.enqueue({ textChunks: ["x", "y"], chunkDelayMs: 800 }, { textChunks: ["q1", "q2", "q3"], chunkDelayMs: 1000 });
    const a = h.stream({ input: "long A" });
    await sleep(200);
    const b = h.post({ input: "queued B" }, { key: SERVICE_KEY });
    await sleep(200);
    const before = h.llm.requests.length;
    const t0 = Date.now();
    await h.close();
    const elapsed = Date.now() - t0;
    const rb = await b;
    await a.catch(() => null);
    expect(elapsed).toBeLessThan(5000);
    expect(rb.status).toBe(503);
    expect(rb.json.error.message).toContain("shutting down");
    expect(h.llm.requests.length - before).toBe(0);
  });
});

describe("6-9. empty replies, merged questions, cache isolation, anonymous purge", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({
      sandboxServers: [
        McpServerConfig.parse({ id: "plugin", runIn: "sandbox", scope: "per-user", transport: { type: "stdio", command: process.execPath, args: [stdioServer] } }),
      ],
    });
    // 8번 테스트용: alice가 자기 workspace에 도구 설명을 심어 둔다 (첫 세션 전에)
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "tool-desc.txt"), "ALICE-PLANTED description");
  });
  afterAll(async () => {
    await h.close();
  });

  it("6. an empty reply fails with empty_response and is not committed", async () => {
    const first = await h.post({ input: "base" });
    h.llm.enqueue({ text: "" });
    const empty = await h.stream({ input: "say nothing", previous_response_id: first.json.id });
    const ev = last(empty.events);
    expect(ev.type).toBe("response.failed");
    expect((ev.data.response as any).error).toEqual({ code: "empty_response", message: "No response generated" });
    expect(h.gateway.store.get(sessionOf(first.json.id))!.turn).toBe(1);
    h.llm.enqueue({ text: "" });
    const nonStream = await h.post({ input: "again", previous_response_id: first.json.id });
    expect(nonStream.status).toBe(502);
    expect(nonStream.json.error.message).toBe("Backend error: No response generated");
    // reasoning만 있는 응답은 성공이다 (빈 message 항목 하나로 끝난다)
    h.llm.enqueue({ reasoning: "thinking only", text: "" });
    const thinking = await h.stream({ model: "think-model", input: "think" });
    expect(last(thinking.events).type).toBe("response.completed");
  });

  it("7. two AskUserQuestion calls in one batch become one function_call with all questions", async () => {
    const q = (question: string) => ({ questions: [{ question, header: "H", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
    h.llm.enqueue({
      toolCalls: [
        { id: "ask_1", name: "AskUserQuestion", arguments: q("First?") },
        { id: "ask_2", name: "AskUserQuestion", arguments: q("Second?") },
      ],
    });
    const res = await h.post({ input: "ask twice" });
    expect(res.json.status).toBe("requires_action");
    expect(res.json.output).toHaveLength(1);
    expect(res.json.output[0].call_id).toBe("ask_1");
    const args = JSON.parse(res.json.output[0].arguments);
    expect(args.questions.map((x: { question: string }) => x.question)).toEqual(["First?", "Second?"]);
    h.llm.enqueue({ text: "thanks" });
    const answered = await h.post({ previous_response_id: res.json.id, input: [{ type: "function_call_output", call_id: "ask_1", output: "A, B" }] });
    expect(answered.status).toBe(200);
    // 두 질문 모두 tool result가 있어 짝이 맞는다
    const toolIds = h.llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(toolIds).toEqual(expect.arrayContaining(["ask_1", "ask_2"]));
  });

  it("8. a tool description planted in alice's workspace never reaches bob", async () => {
    const a = h.llm.requests.length;
    await h.post({ input: "alice" });
    const aliceUpload = h.llm.requests[a]!.tools!.find((t) => t.function.name === "mcp__plugin__upload")!;
    expect(aliceUpload.function.description).toBe("ALICE-PLANTED description");
    const b = h.llm.requests.length;
    await h.post({ input: "bob" }, { key: BOB_KEY });
    const bobUpload = h.llm.requests[b]!.tools!.find((t) => t.function.name === "mcp__plugin__upload")!;
    expect(bobUpload.function.description).toBe("upload a file");
  });

  it("9. the anonymous purge re-checks expiry under the lock (a just-resumed session survives)", async () => {
    const res = await h.post({ input: "anon" }, { key: SERVICE_KEY });
    const sid = sessionOf(res.json.id);
    const stale = { ...h.gateway.store.get(sid)!, lastActiveAt: "2000-01-01T00:00:00.000Z" };
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    // 목록을 읽은 뒤 세션이 다시 쓰였다 (store의 lastActiveAt은 최근이다)
    expect(await h.gateway.hub.purgeAnonymous(stale, cutoff)).toBe(false);
    expect(h.gateway.store.get(sid)).toBeDefined();
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await h.gateway.hub.purgeAnonymous(stale, later)).toBe(true);
    expect(h.gateway.store.get(sid)).toBeUndefined();
  });
});
