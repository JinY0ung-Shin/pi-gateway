import type { Skill } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatRequest } from "./fixtures/fake-llm.js";
import { type Harness, last, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    env: { ADMIN_API_KEY: ADMIN_KEY },
    skills: [
      {
        name: "p:report",
        description: "Writes reports",
        filePath: "/opt/plugins/m/p/current/skills/report/SKILL.md",
        baseDir: "/opt/plugins/m/p/current/skills/report",
        disableModelInvocation: false,
      } as Skill,
    ],
    agents: [{ name: "p:scout", description: "Finds things", tools: ["Read", "Bash(git:*)"], prompt: "You are the scout." }],
    brokerServers: {
      demo: [
        { name: "echo", handler: () => ({ text: "ok" }) },
        { name: "fail", handler: () => ({ text: "refused", isError: true }) },
      ],
    },
  });
});
afterAll(async () => {
  await h.close();
});

const admin = (method: string, path: string) => fetch(`${h.url}/admin/api${path}`, { method, headers: { authorization: `Bearer ${ADMIN_KEY}` } });
const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.function.name);

describe("built-in tool switches", () => {
  it("a disabled tool leaves new sessions, the next turn of a live session, and plugin agents", async () => {
    const first = await h.post({ input: "hi" });
    expect(toolNames(h.llm.requests.at(-1)!)).toContain("bash");

    const off = await admin("POST", "/tools/bash/disable");
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ name: "bash", enabled: false });
    const list = (await (await admin("GET", "/tools")).json()) as { tools: { name: string; enabled: boolean }[] };
    expect(list.tools.find((t) => t.name === "bash")!.enabled).toBe(false);

    // 메모리에 있던 세션도 다음 턴에 새 설정으로 다시 열린다
    await h.post({ input: "again", previous_response_id: first.json.id });
    expect(toolNames(h.llm.requests.at(-1)!)).not.toContain("bash");
    expect(toolNames(h.llm.requests.at(-1)!)).toContain("read");

    h.llm.enqueue(
      { toolCalls: [{ id: "call_a", name: "Agent", arguments: { subagent_type: "p:scout", description: "find x", prompt: "Find x." } }] },
      { text: "x is in a.txt" },
      { text: "Done." },
    );
    await h.post({ input: "where is x?" });
    // [parent, child, after]: 하위 agent도 bash를 받지 않는다
    expect(toolNames(h.llm.requests.at(-2)!)).toEqual(["read"]);

    expect((await admin("POST", "/tools/bash/enable")).status).toBe(200);
    await h.post({ input: "hi" });
    expect(toolNames(h.llm.requests.at(-1)!)).toContain("bash");
  });

  it("only built-in tools can be switched", async () => {
    expect((await admin("POST", "/tools/nope/disable")).status).toBe(404);
    expect((await admin("POST", "/tools/mcp__docs__search/disable")).status).toBe(404);
  });
});

describe("tool stats", () => {
  it("counts executed calls per tool, MCP tools by server/tool, skill reads by skill and subagent calls too", async () => {
    h.llm.enqueue(
      {
        toolCalls: [
          { id: "s1", name: "mcp_call", arguments: { name: "mcp__demo__echo" } },
          { id: "s2", name: "mcp__demo__fail", arguments: {} },
          { id: "s3", name: "nope", arguments: {} },
          { id: "s6", name: "read", arguments: { path: "@/opt/plugins/m/p/current/skills/report/SKILL.md" } },
        ],
      },
      { toolCalls: [{ id: "s4", name: "Agent", arguments: { subagent_type: "p:scout", description: "read x", prompt: "Read x." } }] },
      { toolCalls: [{ id: "s5", name: "read", arguments: { path: "x.txt" } }] },
      { text: "x read" },
      { text: "Done." },
    );
    await h.post({ input: "use tools" });

    const status = (await (await admin("GET", "/status")).json()) as { tools: { tool: string; calls: number; errors: number }[] };
    const stat = (tool: string) => status.tools.find((t) => t.tool === tool);
    expect(stat("demo/echo")).toMatchObject({ calls: 1, errors: 0 });
    expect(stat("demo/fail")).toMatchObject({ calls: 1, errors: 1 });
    expect(stat("skill/p:report")).toMatchObject({ calls: 1 });
    // SKILL.md 읽기는 read에 더하지 않는다 (하위 agent의 read 1번만)
    expect(stat("read")).toMatchObject({ calls: 1 });
    expect(stat("Agent")).toBeDefined();
    // 실행되지 않은 호출(없는 도구)은 세지 않는다
    expect(stat("nope")).toBeUndefined();
    expect(stat("mcp_call")).toBeUndefined();
  });
});

describe("turn stats", () => {
  it("counts committed turns and those continued from an earlier response (edit or regenerate)", async () => {
    const turns = async () => ((await (await admin("GET", "/status")).json()) as { turns: { turns: number; branched: number } }).turns;
    const before = await turns();
    const first = await h.post({ input: "a" });
    await h.post({ input: "b", previous_response_id: first.json.id });
    await h.post({ input: "b edited", previous_response_id: first.json.id });
    const after = await turns();
    expect(after.turns - before.turns).toBe(3);
    expect(after.branched - before.branched).toBe(1);
  });
});

describe("user token usage", () => {
  it("adds each LLM call's tokens to the user, cached tokens included in input", async () => {
    type Row = { user: string; llmCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number };
    const alice = async () =>
      ((await (await admin("GET", "/status")).json()) as { users: Row[] }).users.find((u) => u.user === "alice") ??
      { llmCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    const before = await alice();
    h.llm.enqueue({ text: "ok", usage: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 400 } });
    await h.post({ input: "count me" });
    const after = await alice();
    expect(after.llmCalls - before.llmCalls).toBe(1);
    expect(after.inputTokens - before.inputTokens).toBe(1000);
    expect(after.cachedTokens - before.cachedTokens).toBe(400);
    expect(after.outputTokens - before.outputTokens).toBe(50);
  });
});

describe("active turns", () => {
  it("lists a running turn and stops it from the admin API", async () => {
    h.llm.enqueue({ textChunks: Array.from({ length: 50 }, (_, i) => `c${i} `), chunkDelayMs: 50 });
    const streaming = h.stream({ input: "long task" });
    type Active = { user: string; responseId: string };
    let active: Active[] = [];
    for (let i = 0; i < 40 && active.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      active = ((await (await admin("GET", "/status")).json()) as { activeTurns: Active[] }).activeTurns;
    }
    expect(active).toHaveLength(1);
    expect(active[0]!.user).toBe("alice");

    const stop = await admin("POST", `/chat/${active[0]!.responseId}/cancel?user=alice`);
    expect(stop.status).toBe(200);
    const end = last((await streaming).events);
    expect((end.data.response as { incomplete_details: unknown }).incomplete_details).toEqual({ reason: "user_cancelled" });
  });
});
