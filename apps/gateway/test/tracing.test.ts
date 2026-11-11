import { startTracing } from "@pi-gateway/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "./helpers.js";

/** 턴 하나의 span이 한 trace로 이어지는지: 턴 → LLM 호출·도구 → (하위 agent의 LLM 호출) → sandboxd·broker로 가는 헤더 */

interface Collected {
  name: string;
  traceId: string;
  spanId: string;
  parentId: string | undefined;
  attributes: Record<string, unknown>;
}

const spans: Collected[] = [];
let stop: () => Promise<void>;
let h: Harness;

beforeAll(async () => {
  stop = startTracing("gateway", "unused", {
    export(batch, done) {
      for (const s of batch) {
        const ctx = s.spanContext();
        spans.push({ name: s.name, traceId: ctx.traceId, spanId: ctx.spanId, parentId: s.parentSpanContext?.spanId, attributes: s.attributes });
      }
      done({ code: 0 });
    },
    shutdown: async () => {},
  });
  h = await startHarness({ brokerServers: { demo: [{ name: "echo", handler: () => ({ text: "ok" }) }] } });
});
afterAll(async () => {
  await h.close();
});

it("records one trace per turn and carries it to sandboxd and the broker", async () => {
  h.llm.enqueue(
    { toolCalls: [{ id: "c1", name: "bash", arguments: { command: "echo hi" } }] },
    { toolCalls: [{ id: "c2", name: "mcp_call", arguments: { name: "mcp__demo__echo", arguments: {} } }] },
    { toolCalls: [{ id: "c3", name: "Agent", arguments: { subagent_type: "general-purpose", description: "d", prompt: "p" } }] },
    { text: "child done" },
    { text: "secret-answer" },
  );
  const res = await h.post({ input: "secret-question" });
  expect(res.status).toBe(200);
  await stop();

  const turn = spans.find((s) => s.name === "invoke_agent")!;
  expect(turn.parentId).toBeUndefined();
  expect(turn.attributes).toMatchObject({ "gen_ai.conversation.id": res.json.id.split("_")[1], "pi_gateway.turn": 1, "pi_gateway.status": "completed" });
  expect(spans.every((s) => s.traceId === turn.traceId)).toBe(true);

  const children = (parent: Collected) => spans.filter((s) => s.parentId === parent.spanId).map((s) => s.name).sort();
  expect(children(turn)).toEqual(["chat test-model", "chat test-model", "chat test-model", "chat test-model", "execute_tool Agent", "execute_tool bash", "execute_tool mcp_call"]);
  const tool = (name: string) => spans.find((s) => s.name === `execute_tool ${name}`)!;
  expect(children(tool("Agent"))).toEqual(["chat test-model"]);
  expect(tool("mcp_call").attributes["pi_gateway.mcp_tool"]).toBe("demo/echo");
  const chat = spans.find((s) => s.name === "chat test-model")!;
  expect(chat.attributes["gen_ai.usage.output_tokens"]).toBeTypeOf("number");

  // 다른 서비스로 가는 요청은 그 도구 span을 부모로 알린다
  const parentOf = (traceparent: string | undefined) => traceparent?.split("-").slice(1, 3).join("-");
  expect(parentOf(h.sandbox.calls.find((c) => JSON.stringify(c.body.argv ?? "").includes("echo hi"))?.traceparent)).toBe(`${turn.traceId}-${tool("bash").spanId}`);
  expect(parentOf(h.broker.records.find((r) => r.method === "tools/call")?.traceparent)).toBe(`${turn.traceId}-${tool("mcp_call").spanId}`);

  // 내용은 싣지 않는다
  expect(JSON.stringify(spans)).not.toMatch(/secret-question|secret-answer|echo hi/);
});
