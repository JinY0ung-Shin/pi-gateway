import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatRequest } from "./fixtures/fake-llm.js";
import { type Harness, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    env: { ADMIN_API_KEY: ADMIN_KEY },
    agents: [{ name: "p:scout", description: "Finds things", tools: ["Read", "Bash(git:*)"], prompt: "You are the scout." }],
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
