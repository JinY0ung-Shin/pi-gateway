import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_TOOL_CALLS_PER_TURN } from "../src/agent/tool-call-limit.js";
import { bombPng, tinyPng } from "./fixtures/images.js";
import { ALICE_KEY, BOB_KEY, type Harness, last, ofType, SERVICE_KEY, startHarness } from "./helpers.js";

const RESP_ID = /^resp_[0-9a-f-]{36}_(\d+)$/;

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.llm.setDefault({ text: "ok" });
});

describe("POST /v1/responses — non-stream", () => {
  it("returns a completed response with OpenAI-style fields and mapped usage", async () => {
    h.llm.enqueue({ text: "Hello there.", usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 30 } });
    const res = await h.post({ model: "test-model", input: "hi" });
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body.id).toMatch(RESP_ID);
    expect(body.id.endsWith("_1")).toBe(true);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("test-model");
    expect(body.output).toHaveLength(1);
    expect(body.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed" });
    expect(body.output[0].id).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(body.output[0].content).toEqual([{ type: "output_text", text: "Hello there.", annotations: [] }]);
    // input_tokens는 캐시 읽기를 포함한다
    expect(body.usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 30, cache_creation_tokens: 0, context_tokens: 100 },
    });
    expect(body).toMatchObject({ error: null, incomplete_details: null, structured_output: null, background: null, metadata: {} });
  });

  it("echoes metadata and uses the default model when model is omitted", async () => {
    const res = await h.post({ input: "hi", metadata: { a: "1" } });
    expect(res.status).toBe(200);
    expect(res.json.model).toBe("test-model");
    expect(res.json.metadata).toEqual({ a: "1" });
  });

  it("rejects unknown models with 400", async () => {
    const res = await h.post({ model: "nope", input: "hi" });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toContain("Model 'nope' is not supported");
    expect(res.json.error.code).toBe("400");
  });

  it("returns 422 with details for malformed bodies", async () => {
    const res = await h.post({ input: 5 });
    expect(res.status).toBe(422);
    expect(res.json.error.type).toBe("validation_error");
    expect(Array.isArray(res.json.error.details)).toBe(true);
  });

  it("maps upstream failures to 502 and does not commit the turn", async () => {
    h.llm.enqueue({ error: { status: 500, body: { error: { message: "boom" } } } });
    const res = await h.post({ input: "hi" });
    expect(res.status).toBe(502);
    expect(res.json.error.message).toContain("Backend error");
  });
});

describe("authentication", () => {
  it("401 without a key, with WWW-Authenticate", async () => {
    const res = await h.post({ input: "hi" }, { key: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(res.json.error.message).toBe("Missing API key");
  });

  it("401 with a wrong key", async () => {
    const res = await h.post({ input: "hi" }, { key: "wrong-key-0123456789" });
    expect(res.status).toBe(401);
    expect(res.json.error.message).toBe("Invalid API key");
  });

  it("a user key binds the principal and ignores body.user", async () => {
    const first = await h.post({ input: "hi", user: "mallory" });
    expect(first.status).toBe(200);
    // alice의 세션을 bob 키로 이으면 404
    const bob = await h.post({ input: "again", previous_response_id: first.json.id }, { key: BOB_KEY });
    expect(bob.status).toBe(404);
    expect(bob.json.error.message).toContain("not found or expired");
    // body.user를 alice로 줘도 서비스 키가 아니면 bob은 bob이다
    const bob2 = await h.post({ input: "again", previous_response_id: first.json.id, user: "alice" }, { key: BOB_KEY });
    expect(bob2.status).toBe(404);
  });

  it("the service key trusts body.user and requires it", async () => {
    const named = await h.post({ input: "hi", user: "carol" }, { key: SERVICE_KEY });
    expect(named.status).toBe(200);
    const wrongUser = await h.post({ input: "x", previous_response_id: named.json.id, user: "dave" }, { key: SERVICE_KEY });
    expect(wrongUser.status).toBe(404);
    const noUser = await h.post({ input: "hi" }, { key: SERVICE_KEY });
    expect(noUser.status).toBe(400);
    expect(noUser.json.error.message).toBe("user is required");
  });

  it("rejects an invalid body.user with 400", async () => {
    const res = await h.post({ input: "hi", user: "../etc" }, { key: SERVICE_KEY });
    expect(res.status).toBe(400);
  });
});

describe("continuation", () => {
  it("continues a session with the full history and increments the turn", async () => {
    h.llm.enqueue({ text: "First answer." }, { text: "Second answer." });
    const first = await h.post({ input: "first question" });
    const n = h.llm.requests.length;
    const second = await h.post({ input: "second question", previous_response_id: first.json.id });
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id.replace(/_1$/, "_2"));
    const req = h.llm.requests[n]!;
    const texts = req.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    expect(texts.some((t) => t.includes("first question"))).toBe(true);
    expect(texts.some((t) => t.startsWith("assistant:") && t.includes("First answer."))).toBe(true);
    expect(texts.at(-1)).toContain("second question");
  });

  it("an earlier id branches from that turn; both branches stay continuable", async () => {
    const first = await h.post({ input: "a" });
    const second = await h.post({ input: "b", previous_response_id: first.json.id });
    let n = h.llm.requests.length;
    const edited = await h.post({ input: "b edited", previous_response_id: first.json.id });
    expect(edited.status).toBe(200);
    expect(edited.json.id).toBe(first.json.id.replace(/_1$/, "_3"));
    let sent = JSON.stringify(h.llm.requests[n]!.messages);
    expect(sent).toContain('"a"');
    expect(sent).not.toContain('"b"');
    n = h.llm.requests.length;
    const back = await h.post({ input: "c", previous_response_id: second.json.id });
    expect(back.status).toBe(200);
    sent = JSON.stringify(h.llm.requests[n]!.messages);
    expect(sent).toContain('"b"');
    expect(sent).not.toContain("b edited");
  });

  it("404 for a future or malformed id", async () => {
    const first = await h.post({ input: "a" });
    const second = await h.post({ input: "b", previous_response_id: first.json.id });
    const future = await h.post({ input: "c", previous_response_id: second.json.id.replace(/_2$/, "_9") });
    expect(future.status).toBe(404);
    expect(future.json.error.message).toContain("references a future turn");
    const bad = await h.post({ input: "c", previous_response_id: "resp_nope" });
    expect(bad.status).toBe(404);
    expect(bad.json.error.message).toBe("previous_response_id 'resp_nope' is invalid");
  });

  it("rejects instructions and system items on continuation", async () => {
    const first = await h.post({ input: "a" });
    const withInstructions = await h.post({ input: "b", instructions: "x", previous_response_id: first.json.id });
    expect(withInstructions.status).toBe(400);
    const withSystem = await h.post({
      input: [
        { role: "system", content: "x" },
        { role: "user", content: "b" },
      ],
      previous_response_id: first.json.id,
    });
    expect(withSystem.status).toBe(400);
  });

  it("a failed turn is not committed and is erased from the history", async () => {
    const first = await h.post({ input: "keep me" });
    h.llm.enqueue({ error: { status: 500, body: { error: { message: "boom" } } } });
    const failed = await h.post({ input: "forget me", previous_response_id: first.json.id });
    expect(failed.status).toBe(502);
    const n = h.llm.requests.length;
    const retry = await h.post({ input: "retry", previous_response_id: first.json.id });
    expect(retry.status).toBe(200);
    expect(retry.json.id).toBe(first.json.id.replace(/_1$/, "_2"));
    const sent = JSON.stringify(h.llm.requests[n]!.messages);
    expect(sent).toContain("keep me");
    expect(sent).not.toContain("forget me");
  });

  it("checks reasoning.effort against the session's model when model is omitted", async () => {
    const first = await h.post({ model: "think-model", input: "a", reasoning: { effort: "high" } });
    expect(first.status).toBe(200);
    const same = await h.post({ input: "b", reasoning: { effort: "high" }, previous_response_id: first.json.id });
    expect(same.status).toBe(200);
    const changed = await h.post({ input: "c", reasoning: { effort: "low" }, previous_response_id: same.json.id });
    expect(changed.status).toBe(400);
    expect(changed.json.error.message).toBe("reasoning.effort is fixed when the session is created");
  });

  it("uses the model's default effort and rejects efforts the model does not take", async () => {
    const effortSent = async (body: Record<string, unknown>) => {
      const res = await h.post({ model: "think-model", input: "a", ...body });
      expect(res.status).toBe(200);
      return (h.llm.requests.at(-1) as { reasoning_effort?: string }).reasoning_effort;
    };
    expect(await effortSent({})).toBe("high");
    expect(await effortSent({ reasoning: { effort: "xhigh" } })).toBe("xhigh");
    const rejected = await h.post({ model: "think-model", input: "a", reasoning: { effort: "medium" } });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error.code).toBe("unsupported_reasoning_effort");
  });

  it("continues with the session's model and ignores body.model", async () => {
    const first = await h.post({ model: "think-model", input: "a" });
    const next = await h.post({ model: "nope", input: "b", previous_response_id: first.json.id });
    expect(next.status).toBe(200);
    expect(next.json.model).toBe("think-model");
  });
});

describe("system prompt", () => {
  it("uses the prompt snapshot, first-turn instructions and the current user; keeps them on later turns", async () => {
    h.prompt.text = "Snapshot prompt v1.";
    const first = await h.post({ input: "hi", instructions: "Answer in haiku." });
    const sys1 = String(h.llm.requests.at(-1)!.messages[0]!.content);
    expect(sys1).toContain("Snapshot prompt v1.");
    expect(sys1).toContain("Answer in haiku.");
    expect(sys1).toContain("Current user: alice");
    h.prompt.text = "Snapshot prompt v2.";
    await h.post({ input: "again", previous_response_id: first.json.id });
    const sys2 = String(h.llm.requests.at(-1)!.messages[0]!.content);
    expect(sys2).toBe(sys1);
    h.prompt.text = "You are the test agent.";
  });

  it("uses the last system/developer input item when instructions is absent", async () => {
    await h.post({
      input: [
        { role: "developer", content: "Be terse." },
        { role: "user", content: "hello" },
      ],
    });
    const req = h.llm.requests.at(-1)!;
    expect(String(req.messages[0]!.content)).toContain("Be terse.");
    expect(JSON.stringify(req.messages.at(-1))).toContain("hello");
  });

  it("labels roles when the input has several messages", async () => {
    await h.post({
      input: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const lastMsg = JSON.stringify(h.llm.requests.at(-1)!.messages.at(-1));
    expect(lastMsg).toContain("User: q1");
    expect(lastMsg).toContain("Assistant: a1");
    expect(lastMsg).toContain("User: q2");
  });
});

describe("GET /v1/models", () => {
  it("lists the configured models and requires a key", async () => {
    const res = await fetch(`${h.url}/v1/models`, { headers: { authorization: `Bearer ${ALICE_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(["test-model", "think-model", "vision-model"]);
    expect(body.data[0]).toMatchObject({ object: "model" });
    expect((await fetch(`${h.url}/v1/models`)).status).toBe(401);
  });
});

describe("tool call limit", () => {
  it("ends a turn as incomplete once it exceeds the per-turn tool call limit, and it stays continuable", async () => {
    const calls = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, name: "ls", arguments: { path: "." } }));
    // 상한은 한 턴의 모든 LLM 호출에 걸쳐 센다.
    h.llm.enqueue({ toolCalls: calls(150, 0) }, { toolCalls: calls(MAX_TOOL_CALLS_PER_TURN - 150 + 1, 150) });
    const res = await h.post({ input: "loop" });
    expect(res.json.status).toBe("incomplete");
    expect(res.json.incomplete_details).toEqual({ reason: "max_tool_calls" });

    const next = await h.post({ input: "go on", previous_response_id: res.json.id });
    expect(next.status).toBe(200);
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("loop");
  });
});

describe("POST /v1/responses/{id}/cancel", () => {
  const cancel = (id: string, key = ALICE_KEY, query = "") =>
    fetch(`${h.url}/v1/responses/${id}/cancel${query}`, { method: "POST", headers: { authorization: `Bearer ${key}` } });

  it("stops the active turn, keeps its partial output and lets the next turn continue from it", async () => {
    const first = await h.post({ input: "hi" });
    const id2 = first.json.id.replace(/_1$/, "_2");
    h.llm.enqueue({ textChunks: Array.from({ length: 50 }, (_, i) => `c${i} `), chunkDelayMs: 50 });
    const streaming = h.stream({ input: "long task", previous_response_id: first.json.id });

    // 아직 시작 전이면 404다. 턴이 시작될 때까지 다시 시도한다.
    let res = await cancel(id2);
    for (let i = 0; i < 40 && res.status === 404; i++) {
      await new Promise((r) => setTimeout(r, 50));
      res = await cancel(id2);
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: id2, object: "response", status: "cancelling" });

    const { events } = await streaming;
    const end = last(events);
    expect(end.type).toBe("response.incomplete");
    expect((end.data.response as any).id).toBe(id2);
    expect((end.data.response as any).incomplete_details).toEqual({ reason: "user_cancelled" });

    const again = await cancel(id2);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe("response_not_cancellable");

    const next = await h.post({ input: "continue", previous_response_id: id2 });
    expect(next.status).toBe(200);
    expect(next.json.id.endsWith("_3")).toBe(true);
    // 멈춘 턴의 사용자 메시지는 남는다 (pi는 중단된 assistant 메시지를 다음 요청에 넣지 않는다).
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("long task");
  });

  it("404 for another user's or an unknown response; the service key needs ?user=", async () => {
    const first = await h.post({ input: "hi" });
    expect((await cancel(first.json.id, BOB_KEY)).status).toBe(404);
    expect((await cancel("resp_nope_1")).status).toBe(404);
    expect((await cancel(first.json.id, SERVICE_KEY)).status).toBe(400);
    expect((await cancel(first.json.id, SERVICE_KEY, "?user=alice")).status).toBe(409);
  });
});

describe("input_image", () => {
  const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;
  const withImage = (model: string, image_url: string) => ({
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: "what is this?" }, { type: "input_image", image_url }] }],
  });

  it("sends a data URL image to the model", async () => {
    const res = await h.post(withImage("vision-model", dataUrl(tinyPng())));
    expect(res.status).toBe(200);
    const lastMsg = JSON.stringify(h.llm.requests.at(-1)!.messages.at(-1));
    expect(lastMsg).toContain("what is this?");
    expect(lastMsg).toContain(dataUrl(tinyPng()));
  });

  it("rejects images for text-only models, non-data URLs and image bombs", async () => {
    const textOnly = await h.post(withImage("test-model", dataUrl(tinyPng())));
    expect(textOnly.status).toBe(400);
    expect(textOnly.json.error.code).toBe("unsupported_image_input");
    const remote = await h.post(withImage("vision-model", "https://example.com/a.png"));
    expect(remote.status).toBe(400);
    expect(remote.json.error.code).toBe("unsupported_image_input");
    const bomb = await h.post(withImage("vision-model", dataUrl(bombPng())));
    expect(bomb.status).toBe(400);
    expect(bomb.json.error.code).toBe("invalid_image");
  });
});

describe("POST /v1/responses — stream", () => {
  it("emits the Responses SSE sequence with contiguous sequence numbers", async () => {
    h.llm.enqueue({ textChunks: ["Hel", "lo"], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    const res = await h.stream({ input: "hi" });
    expect(res.status).toBe(200);
    const types = res.events.map((e) => e.type);
    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    res.events.forEach((e, i) => expect(e.data.sequence_number).toBe(i));
    const created = res.events[0]!.data.response as Record<string, unknown>;
    expect(created.status).toBe("in_progress");
    expect(created).not.toHaveProperty("error");
    const done = res.events.find((e) => e.type === "response.output_text.done")!.data;
    expect(done.text).toBe("Hello");
    const completed = last(res.events).data.response as any;
    expect(completed.status).toBe("completed");
    expect(completed.output[0].content[0].text).toBe("Hello");
    expect(completed.usage.input_tokens).toBe(10);
    expect(completed).not.toHaveProperty("incomplete_details");
    // 같은 id
    expect(completed.id).toBe(created.id);
  });

  it("emits reasoning items before text", async () => {
    h.llm.enqueue({ reasoning: "thinking hard", text: "answer" });
    const res = await h.stream({ model: "think-model", input: "hi" });
    const types = res.events.map((e) => e.type);
    expect(types.slice(2, 4)).toEqual(["response.output_item.added", "response.reasoning_summary_part.added"]);
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).toContain("response.reasoning_text.delta");
    const completed = last(res.events).data.response as any;
    expect(completed.output.map((o: { type: string }) => o.type)).toEqual(["reasoning", "message"]);
    expect(completed.output[0].summary[0].text).toBe("thinking hard");
  });

  it("emits response.failed on upstream errors", async () => {
    h.llm.enqueue({ error: { status: 500, body: { error: { message: "boom" } } } });
    const res = await h.stream({ input: "hi" });
    const ev = last(res.events);
    expect(ev.type).toBe("response.failed");
    expect((ev.data.response as any).error.code).toBeDefined();
  });

  it("returns JSON errors (not SSE) before the stream starts", async () => {
    const res = await h.stream({ input: "hi", previous_response_id: "resp_nope" });
    expect(res.status).toBe(404);
    expect(res.json.error.message).toContain("invalid");
  });

  it("an empty reply fails with empty_response (oh-my-gateway compatible)", async () => {
    h.llm.enqueue({ text: "" });
    const res = await h.stream({ input: "hi" });
    const ev = last(res.events);
    expect(ev.type).toBe("response.failed");
    expect((ev.data.response as any).error.code).toBe("empty_response");
    expect(ofType(res.events, "response.output_item.added")).toHaveLength(0);
  });
});
