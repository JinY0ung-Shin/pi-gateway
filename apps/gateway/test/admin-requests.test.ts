import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("request_admin", () => {
  it("leaves a request that the admin lists and deletes", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "call_ra_1", name: "request_admin", arguments: { title: "Install pandas", detail: "pip install pandas failed: 407" } }] },
      { text: "I asked the administrator." },
    );
    const res = await h.post({ input: "analyze data.csv" });
    expect(res.status).toBe(200);

    const list = await h.admin("GET", "/requests");
    expect(list.json.items).toEqual([
      { id: expect.any(Number), user: "alice", sessionId: expect.any(String), title: "Install pandas", detail: "pip install pandas failed: 407", createdAt: expect.any(String) },
    ]);
    expect(res.json.id).toContain(list.json.items[0].sessionId);

    const id = list.json.items[0].id;
    expect((await h.admin("DELETE", `/requests/${id}`)).status).toBe(200);
    expect((await h.admin("GET", "/requests")).json.items).toEqual([]);
    expect((await h.admin("DELETE", `/requests/${id}`)).status).toBe(404);
  });
});
