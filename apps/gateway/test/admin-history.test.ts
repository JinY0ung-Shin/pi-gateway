import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../src/admin/index.js";
import { type Harness, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";
const DAY = 86_400_000;

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY }, overrides: { registerAdminRoutes } });
});
afterAll(async () => {
  await h.close();
});

const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${h.url}/admin/api${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
};

const sessionOf = (id: string) => /^resp_(.+)_\d+$/.exec(id)![1]!;

describe("admin history", () => {
  it("lists sessions and shows the committed transcript", async () => {
    h.llm.enqueue({ text: "first answer" });
    const first = await h.post({ input: "first question" });
    h.llm.enqueue({ text: "second answer" });
    await h.post({ input: "second question", previous_response_id: first.json.id });
    const sid = sessionOf(first.json.id);

    const list = await admin("GET", "/history?user=alice");
    expect(list.status).toBe(200);
    expect(list.json.items[0]).toMatchObject({ id: sid, user: "alice", turn: 2 });
    expect((await admin("GET", "/history?user=nobody")).json.items).toEqual([]);

    const detail = await admin("GET", `/history/${sid}`);
    expect(detail.status).toBe(200);
    // 처음 system 메시지가 모델이 받은 시스템 프롬프트와 도구 선언이다
    const system = detail.json.messages[0];
    expect(system.role).toBe("system");
    expect(Object.values(system.sections).join("\n")).toContain(h.prompt.text);
    expect(system.toolsAdded.map((t: any) => t.name)).toContain("bash");
    const said = detail.json.messages.filter((m: any) => m.role !== "system").map((m: any) => [m.role, JSON.stringify(m.content)]);
    expect(said.map(([role]: string[]) => role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(said[0][1]).toContain("first question");
    expect(said[3][1]).toContain("second answer");
    expect((await admin("GET", "/history/nope")).status).toBe(404);
  });

  it("deletes sessions past the retention period", async () => {
    expect((await admin("GET", "/history/retention")).json.days).toBe(0);
    expect((await admin("PUT", "/history/retention", { days: -1 })).status).toBe(400);
    expect((await admin("PUT", "/history/retention", { days: 1.5 })).status).toBe(400);

    h.llm.enqueue({ text: "bye" });
    const res = await h.post({ input: "old conversation" });
    const sid = sessionOf(res.json.id);
    const file = h.gateway.store.get(sid)!.sessionFile!;
    expect(existsSync(file)).toBe(true);

    // 0일(무기한)이면 지우지 않는다
    await h.gateway.hub.purgeExpired(Date.now() + 10 * DAY);
    expect(h.gateway.store.get(sid)).toBeDefined();

    const put = await admin("PUT", "/history/retention", { days: 2 });
    expect(put.json).toMatchObject({ days: 2, updatedBy: expect.any(String) });
    await h.gateway.hub.purgeExpired(Date.now() + 1 * DAY);
    expect(h.gateway.store.get(sid)).toBeDefined();
    await h.gateway.hub.purgeExpired(Date.now() + 3 * DAY);
    expect(h.gateway.store.get(sid)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(h.gateway.hub.get(sid)).toBeUndefined();
    expect((await h.post({ input: "again", previous_response_id: res.json.id })).status).toBe(404);
  });
});
