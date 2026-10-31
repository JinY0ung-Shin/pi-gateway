import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subagentTools } from "../src/agent/subagents.js";
import type { ChatRequest } from "./fixtures/fake-llm.js";
import { type Harness, ofType, startHarness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    agents: [{ name: "p:scout", description: "Finds things", tools: ["Read", "Bash(git:*)"], prompt: "You are the scout." }],
  });
});
afterAll(async () => {
  await h.close();
});

const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.function.name).sort();
const system = (r: ChatRequest) => r.messages.find((m) => m.role === "system")?.content;
const toolResult = (r: ChatRequest) => JSON.stringify(r.messages.filter((m) => m.role === "tool").at(-1)?.content);

describe("Agent / SendMessage", () => {
  it("runs a plugin agent as a sub-session and continues it with SendMessage", async () => {
    const start = h.llm.requests.length;
    h.llm.enqueue(
      { toolCalls: [{ id: "call_a", name: "Agent", arguments: { subagent_type: "p:scout", description: "find x", prompt: "Find x." } }] },
      { text: "x is in a.txt" },
      { text: "Done." },
    );
    const first = await h.post({ input: "where is x?" });
    expect(first.status).toBe(200);
    const [parent, child, after] = h.llm.requests.slice(start);
    expect(toolNames(parent!)).toEqual(["Agent", "AskUserQuestion", "SendMessage", "bash", "edit", "find", "grep", "ls", "present_file", "read", "request_admin", "write"]);
    // 하위 세션: agent 본문이 시스템 프롬프트, 도구는 frontmatter tools만 (Agent·SendMessage·AskUserQuestion 없음)
    expect(system(child!)).toContain("You are the scout.");
    expect(toolNames(child!)).toEqual(["bash", "read"]);
    expect(JSON.stringify(child!.messages)).not.toContain("where is x?");
    const agentId = /agent_id: ([a-f0-9]{16})/.exec(toolResult(after!))?.[1];
    expect(toolResult(after!)).toContain("x is in a.txt");
    expect(agentId).toBeDefined();

    h.llm.enqueue(
      { toolCalls: [{ id: "call_s", name: "SendMessage", arguments: { to: agentId, message: "And y?" } }] },
      { text: "y is in b.txt" },
      { text: "Done again." },
    );
    const second = await h.post({ input: "and y?", previous_response_id: first.json.id });
    expect(second.status).toBe(200);
    const resumed = h.llm.requests.at(-2)!;
    // 이전 맥락을 이어서 받는다
    expect(JSON.stringify(resumed.messages)).toContain("Find x.");
    expect(JSON.stringify(resumed.messages)).toContain("x is in a.txt");
    expect(toolResult(h.llm.requests.at(-1)!)).toContain("y is in b.txt");
  });

  it("streams the subagent's tool calls tagged with the Agent call as parent_tool_use_id", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "call_p", name: "Agent", arguments: { subagent_type: "p:scout", description: "look", prompt: "Look." } }] },
      { toolCalls: [{ id: "call_c", name: "bash", arguments: { command: "echo from-child" } }] },
      { text: "child done" },
      { text: "parent done" },
    );
    const res = await h.stream({ input: "look" });
    const tools = res.events.filter((e) => e.type.startsWith("response.tool_"));
    const child = tools.filter((e) => e.data.tool_use_id === "call_c");
    expect(child.map((e) => e.type)).toEqual(expect.arrayContaining(["response.tool_use_started", "response.tool_use", "response.tool_result"]));
    for (const e of child) expect(e.data.parent_tool_use_id).toBe("call_p");
    expect(child.find((e) => e.type === "response.tool_use")!.data).toMatchObject({ name: "bash", input: { command: "echo from-child" } });
    expect(String(child.find((e) => e.type === "response.tool_result")!.data.content)).toContain("from-child");
    // 부모 호출의 이벤트는 그대로다: parent_tool_use_id가 없고, 결과는 하위 도구 결과 뒤에 온다.
    const parent = tools.filter((e) => e.data.tool_use_id === "call_p");
    expect(parent.map((e) => e.type)).toEqual(["response.tool_use_started", "response.tool_use", "response.tool_result"]);
    for (const e of parent) expect(e.data).not.toHaveProperty("parent_tool_use_id");
    expect(tools.indexOf(parent[2]!)).toBeGreaterThan(tools.indexOf(child.at(-1)!));
    expect(String(parent[2]!.data.content)).toContain("child done");
    // 하위 agent의 텍스트는 부모 응답의 텍스트가 되지 않는다
    expect(ofType(res.events, "response.output_text.delta").map((e) => e.data.delta).join("")).toBe("parent done");
  });

  it("returns a tool error for an unknown agent_id", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_x", name: "SendMessage", arguments: { to: "0123456789abcdef", message: "hi" } }] }, { text: "ok" });
    const res = await h.post({ input: "ping" });
    expect(res.status).toBe(200);
    expect(toolResult(h.llm.requests.at(-1)!)).toContain("agent '0123456789abcdef' not found");
  });

  it("gives mcp_search and mcp_call to an agent whose frontmatter tools name MCP tools", () => {
    const tools = ["read", "bash", "mcp_search", "mcp_call"].map((name) => ({ name }) as ToolDefinition);
    const agent = { name: "p:mcp", description: "", prompt: "", filePath: "", tools: ["Read", "mcp__plugin_p_srv__fetch"] };
    expect(subagentTools(agent, tools).map((t) => t.name)).toEqual(["read", "mcp_search", "mcp_call"]);
  });
});
