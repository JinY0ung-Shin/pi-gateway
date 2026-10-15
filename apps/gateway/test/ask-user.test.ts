import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, last, ofType, startHarness } from "./helpers.js";

const QUESTIONS = {
  questions: [
    {
      question: "Which database should I use?",
      header: "DB",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "relational" },
        { label: "SQLite", description: "embedded" },
      ],
    },
  ],
};

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("AskUserQuestion", () => {
  it("pauses with requires_action (stream), then resumes with function_call_output", async () => {
    h.llm.enqueue({ text: "Let me ask.", toolCalls: [{ id: "call_ask_1", name: "AskUserQuestion", arguments: QUESTIONS }] });
    const before = h.llm.requests.length;
    const res = await h.stream({ input: "set up a db" });
    // terminate: 질문 뒤에 LLM을 다시 부르지 않는다
    expect(h.llm.requests.length - before).toBe(1);

    const toolUse = ofType(res.events, "response.tool_use")[0]!.data;
    expect(toolUse).toMatchObject({ tool_use_id: "call_ask_1", name: "AskUserQuestion", input: QUESTIONS });
    // AskUserQuestion의 내부 자리표시자 결과는 보내지 않는다
    expect(ofType(res.events, "response.tool_result")).toHaveLength(0);
    // 질문 전에 열린 텍스트 항목은 닫는다
    const types = res.events.map((e) => e.type);
    expect(types.indexOf("response.output_item.done")).toBeLessThan(types.lastIndexOf("response.output_item.added"));

    const added = ofType(res.events, "response.output_item.added").at(-1)!.data;
    const completed = last(res.events);
    expect(completed.type).toBe("response.completed");
    const response = completed.data.response as any;
    expect(added.response_id).toBe(response.id);
    expect(added.item).toEqual({
      type: "function_call",
      id: "fc_call_ask_1",
      call_id: "call_ask_1",
      name: "AskUserQuestion",
      arguments: JSON.stringify(QUESTIONS),
      status: "completed",
    });
    expect(response.status).toBe("requires_action");
    expect(response.output).toEqual([added.item]);
    expect(response.id.endsWith("_1")).toBe(true);

    // 대기 중에 일반 메시지를 보내면 409
    const plain = await h.post({ input: "hello?", previous_response_id: response.id });
    expect(plain.status).toBe(409);
    expect(plain.json.error.message).toContain("waiting for the user's decision on AskUserQuestion (call_id 'call_ask_1')");

    // call_id가 다르면 400
    const wrong = await h.post({
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: "call_other", output: "Postgres" }],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toContain("call_id mismatch");

    // 올바른 답
    h.llm.enqueue({ text: "Great, Postgres it is." });
    const n = h.llm.requests.length;
    const answered = await h.stream({
      previous_response_id: response.id,
      input: [{ type: "function_call_output", call_id: "call_ask_1", output: "Postgres" }],
    });
    const final = last(answered.events).data.response as any;
    expect(final.status).toBe("completed");
    expect(final.id.endsWith("_2")).toBe(true);
    expect(final.output[0].content[0].text).toBe("Great, Postgres it is.");
    const messages = h.llm.requests[n]!.messages;
    expect(JSON.stringify(messages.at(-1))).toContain("User responded: Postgres");
    // 질문 tool call과 결과가 기록에 남아 있다 (도구 호출 짝이 맞는다)
    expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "call_ask_1")).toBe(true);

    // 답한 뒤에는 대기 상태가 아니다
    const again = await h.post({
      previous_response_id: final.id,
      input: [{ type: "function_call_output", call_id: "call_ask_1", output: "again" }],
    });
    expect(again.status).toBe(400);
    expect(again.json.error.message).toBe("function_call_output received but no pending tool call in session");
  });

  it("non-stream returns a requires_action body", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_ask_2", name: "AskUserQuestion", arguments: QUESTIONS }] });
    const res = await h.post({ input: "ask me" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("requires_action");
    expect(res.json.output).toHaveLength(1);
    expect(res.json.output[0]).toMatchObject({ type: "function_call", call_id: "call_ask_2", name: "AskUserQuestion" });
    expect(JSON.parse(res.json.output[0].arguments)).toEqual(QUESTIONS);
  });

  it("still ends the turn when AskUserQuestion is called together with another tool", async () => {
    h.llm.enqueue({
      toolCalls: [
        { id: "call_bash_x", name: "bash", arguments: { command: "echo side" } },
        { id: "call_ask_3", name: "AskUserQuestion", arguments: QUESTIONS },
      ],
    });
    const before = h.llm.requests.length;
    const res = await h.post({ input: "both" });
    expect(h.llm.requests.length - before).toBe(1);
    expect(res.json.status).toBe("requires_action");
    expect(res.json.output[0].call_id).toBe("call_ask_3");
  });

  it("survives an idle eviction while waiting (state is in the session record, not memory)", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_ask_4", name: "AskUserQuestion", arguments: QUESTIONS }] });
    const res = await h.post({ input: "ask then wait" });
    const sessionId = /^resp_(.+)_1$/.exec(res.json.id)![1]!;
    await h.gateway.hub.evict(sessionId);
    expect(h.gateway.hub.get(sessionId)).toBeUndefined();
    h.llm.enqueue({ text: "resumed" });
    const answered = await h.post({
      previous_response_id: res.json.id,
      input: [{ type: "function_call_output", call_id: "call_ask_4", output: "SQLite" }],
    });
    expect(answered.status).toBe(200);
    expect(answered.json.output[0].content[0].text).toBe("resumed");
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("User responded: SQLite");
  });

  it("an invalid AskUserQuestion call is a normal tool error, not a pause", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_bad", name: "AskUserQuestion", arguments: { questions: [] } }] }, { text: "sorry" });
    const res = await h.post({ input: "bad ask" });
    expect(res.json.status).toBe("completed");
  });
});
