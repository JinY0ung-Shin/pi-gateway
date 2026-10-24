// 실제 LLM(OpenRouter 무료 모델)과의 경계: 스트리밍·reasoning 파싱, 도구 스키마 호환, 여러 턴 흐름.
// PI_GW_LLM_TESTS=1 이고 OPENROUTER_API_KEY가 있을 때만 돈다.
//   PI_GW_LLM_TESTS=1 node --env-file=.env node_modules/vitest/vitest.mjs run apps/gateway/test/e2e-llm.test.ts
// 모델 응답은 매번 다르므로 내용이 아니라 구조(상태, 호출된 도구)만 확인한다.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, last, ofType, type SseEvent, startHarness } from "./helpers.js";

const enabled = process.env.PI_GW_LLM_TESTS === "1" && !!process.env.OPENROUTER_API_KEY;
const MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const TIMEOUT = 180_000;

let h: Harness;

const toolUses = (events: SseEvent[], name: string) => ofType(events, "response.tool_use").filter((e) => e.data.name === name);
const toolResults = (events: SseEvent[]) => ofType(events, "response.tool_result").map((e) => e.data);
const finalResponse = (events: SseEvent[]) => last(events).data.response as { id: string; status: string };

describe.skipIf(!enabled)("gateway + real LLM (OpenRouter)", () => {
  beforeAll(async () => {
    h = await startHarness({
      llm: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        models: [{ id: MODEL, contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text"] }],
        defaultModel: MODEL,
      },
      agents: [
        {
          name: "e2e:poet",
          description: "Writes a short haiku about a given topic.",
          tools: ["Read"],
          prompt: "You are a poet. Reply with only the requested poem or translation, nothing else.",
        },
      ],
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("streams reasoning and text, and runs a bash tool round trip", async () => {
    const res = await h.stream({ input: "Use the bash tool to run `echo hello-e2e`, then tell me what it printed." });
    expect(res.status).toBe(200);
    expect(finalResponse(res.events).status).toBe("completed");
    expect(ofType(res.events, "response.reasoning_text.delta").length).toBeGreaterThan(0);
    expect(ofType(res.events, "response.output_text.delta").length).toBeGreaterThan(0);
    expect(toolUses(res.events, "bash").length).toBeGreaterThan(0);
    expect(toolResults(res.events).some((r) => !r.is_error && String(r.content).includes("hello-e2e"))).toBe(true);
  }, TIMEOUT);

  it("pauses on AskUserQuestion and resumes with the answer", async () => {
    const asked = await h.stream({
      input: "Before anything else, use the AskUserQuestion tool to ask me which color I prefer, with the options red and blue.",
    });
    const pending = finalResponse(asked.events);
    expect(pending.status).toBe("requires_action");
    const call = toolUses(asked.events, "AskUserQuestion")[0]?.data;
    expect(call).toBeDefined();
    expect((call!.input as { questions: unknown[] }).questions.length).toBeGreaterThan(0);

    const answered = await h.stream({
      previous_response_id: pending.id,
      input: [{ type: "function_call_output", call_id: call!.tool_use_id, output: "blue" }],
    });
    expect(finalResponse(answered.events).status).toBe("completed");
  }, TIMEOUT);

  it("runs a plugin agent with Agent and continues it with SendMessage", async () => {
    const first = await h.stream({
      input: "Use the Agent tool with subagent_type e2e:poet to write a haiku about the sea. Then tell me the haiku and the agent_id.",
    });
    expect(finalResponse(first.events).status).toBe("completed");
    expect(toolUses(first.events, "Agent").length).toBeGreaterThan(0);
    expect(toolResults(first.events).some((r) => !r.is_error && /agent_id: [a-f0-9]{16}/.test(String(r.content)))).toBe(true);

    const second = await h.stream({
      previous_response_id: finalResponse(first.events).id,
      input: "Now use SendMessage with that agent_id to ask the same poet agent to translate its haiku into Korean.",
    });
    expect(finalResponse(second.events).status).toBe("completed");
    expect(toolUses(second.events, "SendMessage").length).toBeGreaterThan(0);
    expect(toolResults(second.events).some((r) => !r.is_error)).toBe(true);
  }, TIMEOUT);
});
