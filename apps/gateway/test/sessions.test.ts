import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactionTokens } from "../src/agent/session-factory.js";
import { contextTokensAfterCompaction, estimateContext, type ResponseUsage } from "../src/api/mapper.js";
import { ALICE_KEY, BOB_KEY, type Harness, last, ofType, parseSse, startHarness } from "./helpers.js";

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

  it("two concurrent requests from one id run one after the other as two branches", async () => {
    const h2 = await startHarness();
    try {
      const first = await h2.post({ input: "base" });
      h2.llm.enqueue({ text: "one", delayMs: 400 }, { text: "two" });
      const [a, b] = await Promise.all([
        h2.post({ input: "a", previous_response_id: first.json.id }),
        h2.post({ input: "b", previous_response_id: first.json.id }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.json.id, b.json.id].map((id: string) => id.split("_").at(-1)).sort()).toEqual(["2", "3"]);
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

describe("compaction events", () => {
  let h: Harness;
  beforeAll(async () => {
    // 짧은 대화도 요약되도록 최근 유지 분량을 줄인다 (test-model context 32000, reserve 8000)
    h = await startHarness({
      overrides: { piSettings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 10 } } },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it("streams response.compaction around pi's compaction and reports the context after it", async () => {
    // 요약되는 부분(첫 질문)이 요약보다 길어야 요약 뒤에 context가 줄어든다
    const texts = ["first question, with a long background. ".repeat(40), "First answer with some history to summarize.", "second question", "Second answer."];
    h.llm.enqueue({ text: texts[1] });
    const first = await h.post({ input: texts[0] });
    h.llm.enqueue({ text: texts[3], usage: { prompt_tokens: 30000, completion_tokens: 20 } }, { text: "Summary of the conversation." });
    const res = await h.stream({ input: texts[2], previous_response_id: first.json.id });
    const compaction = ofType(res.events, "response.compaction").map((e) => e.data.status);
    expect(compaction).toEqual(["in_progress", "completed"]);
    const done = last(res.events);
    expect(done.type).toBe("response.completed");
    const { usage } = done.data.response as { usage: ResponseUsage };
    expect(usage.context_window).toBe(32000);
    // 요약 전 usage(입력 30000 + 출력 20)에서 대화 몫이, 대화 추정치(글자 수 / 4)가 준 비율만큼 준다. pi의 추정치 그대로가 아니다
    const after = estimateContext(h.gateway.hub.get(sessionOf(first.json.id))!.agent.session);
    const before = { system: after.system, conversation: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) };
    expect(after.conversation).toBeLessThan(before.conversation);
    expect(usage.input_tokens_details.context_tokens).toBe(contextTokensAfterCompaction(30020, before, after));
    expect(usage.input_tokens_details.context_tokens).toBeLessThan(30020);
  });
});

describe("POST /v1/responses/{id}/compact", () => {
  let h: Harness;
  beforeAll(async () => {
    // 짧은 대화도 요약되도록 최근 유지 분량을 줄인다
    h = await startHarness({
      overrides: { piSettings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 10 } } },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  /** 요약을 요청하고 SSE를 끝까지 읽는다. `done`은 마지막 `response.compaction` 이벤트다 (스트림 전에 거절되면 없다). */
  const compact = async (id: string, body: unknown = {}, key = ALICE_KEY) => {
    const res = await fetch(`${h.url}/v1/responses/${id}/compact`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    const stream = res.headers.get("content-type")?.includes("text/event-stream");
    const events = stream ? parseSse(raw) : [];
    return { status: res.status, events, done: events.at(-1)?.data as any, json: stream ? undefined : (JSON.parse(raw) as any) };
  };
  /** 두 턴짜리 대화. 첫 턴만 요약되도록 둘째 질문을 최근 유지 분량보다 길게 하고, 첫 답에 요약 전 기록에만 있는 말을 넣는다. */
  const twoTurns = async () => {
    h.llm.enqueue({ text: "The secret word is PINEAPPLE." });
    const first = await h.post({ input: "tell me the secret word" });
    h.llm.enqueue({ text: "Noted." });
    const second = await h.post({ input: "thanks, and now let us move on to a different and much longer topic", previous_response_id: first.json.id });
    return second.json.id as string;
  };

  it("summarizes the history into a new turn that the next turn continues", async () => {
    const id = await twoTurns();
    h.llm.enqueue({ text: "SUMMARY-OF-HISTORY" });
    const res = await compact(id, { instructions: "keep the decisions" });
    expect(res.status).toBe(200);
    expect(res.events.map((e) => [e.type, e.data.status])).toEqual([
      ["response.compaction", "in_progress"],
      ["response.compaction", "completed"],
    ]);
    expect(res.done).toMatchObject({ id: `resp_${sessionOf(id)}_3`, context_window: 32000 });
    expect(res.done.tokens_before).toBeGreaterThan(0);
    expect(res.done.tokens_after).toBeGreaterThan(0);
    // 요약 요청에 지침이 들어간다
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("keep the decisions");

    h.llm.enqueue({ text: "ok" });
    const next = await h.post({ input: "continue", previous_response_id: res.done.id });
    expect(next.json.id).toBe(`resp_${sessionOf(id)}_4`);
    const sent = JSON.stringify(h.llm.requests.at(-1)!.messages);
    expect(sent).toContain("SUMMARY-OF-HISTORY");
    expect(sent).not.toContain("PINEAPPLE");

    // 요약 전 응답으로 이어가면 요약 전 기록에서 갈라진다
    h.llm.enqueue({ text: "ok" });
    await h.post({ input: "branch", previous_response_id: id });
    const branched = JSON.stringify(h.llm.requests.at(-1)!.messages);
    expect(branched).toContain("PINEAPPLE");
    expect(branched).not.toContain("SUMMARY-OF-HISTORY");
  });

  it("reports the context after the summary on the usage's scale, not pi's bare estimate", async () => {
    const texts = ["tell me the secret word", "The secret word is PINEAPPLE.", "thanks, and now let us move on to a different and much longer topic", "Noted."];
    h.llm.enqueue({ text: texts[1] });
    const first = await h.post({ input: texts[0] });
    // 마지막 응답의 usage가 요약 전 크기다: 글자 수로 센 추정치(수십 token)와 기준이 다르다.
    h.llm.enqueue({ text: texts[3], usage: { prompt_tokens: 5000, completion_tokens: 5 } });
    const second = await h.post({ input: texts[2], previous_response_id: first.json.id });
    h.llm.enqueue({ text: "SUMMARY" });
    const res = await compact(second.json.id);
    expect(res.done.status).toBe("completed");
    expect(res.done.tokens_before).toBe(5005);
    // 시스템 프롬프트 몫은 그대로 두고, 나머지(대화)가 대화 추정치가 준 비율만큼 준다
    const after = estimateContext(h.gateway.hub.get(sessionOf(second.json.id))!.agent.session);
    const before = { system: after.system, conversation: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) };
    expect(after.conversation).toBeLessThan(before.conversation);
    expect(res.done.tokens_after).toBe(contextTokensAfterCompaction(5005, before, after));
    expect(res.done.tokens_after).toBeGreaterThan(after.system + after.conversation);
    expect(res.done.tokens_after).toBeLessThan(5005);
  });

  it("ends failed (nothing_to_compact) right after a compaction and leaves the session as it was", async () => {
    const id = await twoTurns();
    h.llm.enqueue({ text: "SUMMARY" });
    const done = (await compact(id)).done;
    const again = await compact(done.id);
    expect(again.status).toBe(200);
    expect(again.done).toMatchObject({ status: "failed", error: { code: "nothing_to_compact" } });
    h.llm.enqueue({ text: "ok" });
    const next = await h.post({ input: "continue", previous_response_id: done.id });
    expect(next.json.id).toBe(`resp_${sessionOf(id)}_4`);
  });

  it("does not commit a failed compaction", async () => {
    const id = await twoTurns();
    h.llm.enqueue({ error: { status: 500, body: { error: { message: "boom" } } } });
    const res = await compact(id);
    expect(res.done).toMatchObject({ status: "failed", error: { code: "sdk_error" } });
    h.llm.enqueue({ text: "ok" });
    const next = await h.post({ input: "continue", previous_response_id: id });
    expect(next.json.id).toBe(`resp_${sessionOf(id)}_3`);
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("PINEAPPLE");
  });

  it("does not commit a compaction whose client went away", async () => {
    const id = await twoTurns();
    h.llm.enqueue({ text: "SUMMARY", delayMs: 800 });
    const abort = new AbortController();
    const pending = fetch(`${h.url}/v1/responses/${id}/compact`, {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE_KEY}`, "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    }).then((res) => res.text());
    await new Promise((r) => setTimeout(r, 200));
    abort.abort();
    await pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.gateway.hub.get(sessionOf(id))?.activeTurn ?? null).toBeNull();
    h.llm.enqueue({ text: "ok" });
    const next = await h.post({ input: "continue", previous_response_id: id });
    expect(next.json.id).toBe(`resp_${sessionOf(id)}_3`);
  });

  it("takes down a session it had to open itself, so the next turn opens it with its own request context", async () => {
    const id = await twoTurns();
    const sid = sessionOf(id);
    await h.gateway.hub.evict(sid);
    h.llm.enqueue({ text: "SUMMARY" });
    const res = await compact(id);
    expect(res.done.status).toBe("completed");
    expect(h.gateway.hub.get(sid)).toBeUndefined();
    h.llm.enqueue({ text: "ok" });
    const next = await h.post({ input: "continue", previous_response_id: res.done.id });
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("SUMMARY");
    expect(next.status).toBe(200);

    // 이미 떠 있던 세션은 그대로 둔다.
    const live = h.gateway.hub.get(sid);
    const other = await twoTurns();
    expect(h.gateway.hub.get(sid)).toBe(live);
    h.llm.enqueue({ text: "SUMMARY" });
    await compact(other);
    expect(h.gateway.hub.get(sessionOf(other))).toBeDefined();
  });

  it("refuses another user's response, an unknown one, and a session with a response in progress", async () => {
    const id = await twoTurns();
    expect((await compact(id, {}, BOB_KEY)).status).toBe(404);
    expect((await compact(`resp_${sessionOf(id)}_9`)).status).toBe(404);
    expect((await compact(id, { instructions: 1 })).status).toBe(400);

    h.llm.enqueue({ text: "slow", delayMs: 1500 });
    const running = h.stream({ input: "long", previous_response_id: id });
    await new Promise((r) => setTimeout(r, 300));
    const busy = await compact(id);
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("response_in_progress");
    await running;
  });
});
