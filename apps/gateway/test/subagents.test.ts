import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subagentTools } from "../src/agent/subagents.js";
import type { ChatRequest } from "./fixtures/fake-llm.js";
import { type Harness, startHarness } from "./helpers.js";

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
