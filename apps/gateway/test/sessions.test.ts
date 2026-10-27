import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactionTokens } from "../src/agent/session-factory.js";
import { BOB_KEY, type Harness, last, startHarness } from "./helpers.js";

const sessionOf = (id: string) => /^resp_(.+)_\d+$/.exec(id)![1]!;

describe("session lifecycle", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ env: { SESSION_IDLE_SECONDS: "0" } });
  });
  afterAll(async () => {
    await h.close();
  });

  it("idle sessions are torn down and rehydrated from JSONL with the same history and prompt", async () => {
    h.prompt.text = "Prompt A.";
    h.llm.enqueue({ text: "remember 42" });
    const first = await h.post({ input: "the number is 42" });
    const sid = sessionOf(first.json.id);
    expect(h.gateway.hub.get(sid)).toBeDefined();
    const sessionDir = join(h.config.dataDir, "sessions", userKey("alice"));
    expect(readdirSync(sessionDir).some((f) => f.endsWith(".jsonl") && f.includes(sid))).toBe(true);
    const sys1 = String(h.llm.requests.at(-1)!.messages[0]!.content);

    await h.gateway.hub.reap();
    expect(h.gateway.hub.get(sid)).toBeUndefined();

    h.prompt.text = "Prompt B (new deployments only affect new sessions).";
    h.llm.enqueue({ text: "it was 42" });
    const second = await h.post({ input: "what was the number?", previous_response_id: first.json.id });
    expect(second.status).toBe(200);
    expect(second.json.id.endsWith("_2")).toBe(true);
    const req = h.llm.requests.at(-1)!;
    expect(String(req.messages[0]!.content)).toBe(sys1);
    const sent = JSON.stringify(req.messages);
    expect(sent).toContain("the number is 42");
    expect(sent).toContain("remember 42");
  });

  it("a session whose transcript disappeared is treated as expired (404) and cleaned up", async () => {
    const first = await h.post({ input: "will lose transcript" });
    const sid = sessionOf(first.json.id);
    const file = h.gateway.store.get(sid)!.sessionFile!;
    await h.gateway.hub.evict(sid);
    rmSync(file);
    const res = await h.post({ input: "again", previous_response_id: first.json.id });
    expect(res.status).toBe(404);
    expect(res.json.error.message).toContain("not found or expired");
    expect(h.gateway.store.get(sid)).toBeUndefined();
  });

  it("a failed first turn leaves no session behind", async () => {
    h.llm.enqueue({ error: { status: 500, body: { error: { message: "down" } } } });
    const count = () => h.gateway.store.list("alice", 1000).length;
    const before = count();
    const res = await h.post({ input: "first" });
    expect(res.status).toBe(502);
    expect(count()).toBe(before);
  });
});

describe("concurrency and cancellation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ env: { MAX_CONCURRENT_TURNS: "1", TURN_QUEUE_TIMEOUT_SECONDS: "1", NON_STREAM_TIMEOUT_SECONDS: "1" } });
  });
  afterAll(async () => {
    await h.close();
  });

  it("rejects with 503 concurrency_limit_exceeded when the queue wait times out", async () => {
    // 비스트리밍 제한 시간(1초)에 걸리지 않도록 스트리밍으로 보낸다
    h.llm.enqueue({ text: "slow", delayMs: 1800 });
    const slow = h.stream({ input: "slow one" });
    await new Promise((r) => setTimeout(r, 150));
    const blocked = await h.post({ input: "blocked" }, { key: BOB_KEY });
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("30");
    expect(blocked.json.error).toMatchObject({ type: "server_overloaded", code: "concurrency_limit_exceeded", retry_after: 30 });
    expect((await slow).status).toBe(200);
  });

  it("a queued request runs once a slot frees up", async () => {
    h.llm.enqueue({ text: "short", delayMs: 300 });
    const first = h.post({ input: "short one" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await h.post({ input: "waits" }, { key: BOB_KEY });
    expect(second.status).toBe(200);
    expect((await first).status).toBe(200);
  });

  it("times out long non-stream turns with 504 and does not commit", async () => {
    const first = await h.post({ input: "base" });
    h.llm.enqueue({ text: "too late", delayMs: 2500 });
    const res = await h.post({ input: "slow", previous_response_id: first.json.id });
    expect(res.status).toBe(504);
    expect(res.json.error.message).toContain("timed out");
    expect(h.gateway.store.get(sessionOf(first.json.id))!.turn).toBe(1);
  });

  it("a client disconnect aborts the run and the turn is not committed", async () => {
    const first = await h.post({ input: "base" });
    const sid = sessionOf(first.json.id);
    h.llm.enqueue({ textChunks: ["a", "b", "c", "d", "e", "f"], chunkDelayMs: 300 });
    const controller = new AbortController();
    const res = await fetch(`${h.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer alice-key-0123456789abcdef" },
      body: JSON.stringify({ input: "stream then leave", previous_response_id: first.json.id, stream: true }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 700));
    expect(h.gateway.store.get(sid)!.turn).toBe(1);
    expect(h.gateway.hub.get(sid)?.activeTurn ?? null).toBeNull();
    // 같은 previous_response_id로 다시 이어갈 수 있다
    h.llm.enqueue({ text: "back" });
    const again = await h.post({ input: "again", previous_response_id: first.json.id });
    expect(again.status).toBe(200);
    expect(again.json.id.endsWith("_2")).toBe(true);
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).not.toContain("stream then leave");
  });

  it("the second of two concurrent requests on one session gets 409", async () => {
    const h2 = await startHarness();
    try {
      const first = await h2.post({ input: "base" });
      h2.llm.enqueue({ text: "one", delayMs: 400 }, { text: "two" });
      const [a, b] = await Promise.all([
        h2.post({ input: "a", previous_response_id: first.json.id }),
        h2.post({ input: "b", previous_response_id: first.json.id }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    } finally {
      await h2.close();
    }
  });

  it("shutdown aborts active streams", async () => {
    const h3 = await startHarness();
    h3.llm.enqueue({ textChunks: ["x", "y", "z"], chunkDelayMs: 1000 });
    const pending = h3.stream({ input: "long" });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await h3.close();
    const res = await pending.catch(() => null);
    expect(Date.now() - started).toBeLessThan(5000);
    // 연결이 살아 있으므로 종료 사유를 response.failed로 알린다
    expect(res).not.toBeNull();
    const ev = last(res!.events);
    expect(ev.type).toBe("response.failed");
    expect((ev.data.response as any).error.message).toBe("Gateway is shutting down");
  });
});

describe("compaction thresholds", () => {
  it("keep pi defaults for large models and scale down for small ones", () => {
    expect(compactionTokens(200_000)).toEqual({ reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(compactionTokens(32768)).toEqual({ reserveTokens: 8192, keepRecentTokens: 8192 });
  });
});
