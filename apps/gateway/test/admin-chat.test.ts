import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, last, parseSse, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY } });
});
afterAll(async () => {
  await h.close();
});

const chat = (body: unknown, auth: string | null = `Bearer ${ADMIN_KEY}`) =>
  fetch(`${h.url}/admin/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /admin/api/chat", () => {
  it("runs a /v1/responses turn as the given user with the admin login", async () => {
    h.llm.enqueue({ text: "hello from admin chat" });
    const res = await chat({ user: "tester", input: "hi", stream: true });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const end = last(events);
    expect(end.type).toBe("response.completed");
    expect(JSON.stringify(end.data)).toContain("hello from admin chat");
    expect(String(h.llm.requests.at(-1)!.messages[0]!.content)).toContain("Current user: tester");
  });

  it("needs the admin login, and returns /v1/responses errors as they are", async () => {
    expect((await chat({ user: "tester", input: "hi" }, null)).status).toBe(401);
    // API 키로는 쓸 수 없다
    expect((await chat({ user: "tester", input: "hi" }, "Bearer alice-key-0123456789abcdef")).status).toBe(401);
    const noUser = await chat({ input: "hi" });
    expect(noUser.status).toBe(400);
    expect(((await noUser.json()) as any).error.message).toBe("user is required");
  });

  it("lists the chat options", async () => {
    const res = await fetch(`${h.url}/admin/api/chat/options`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.defaultModel).toBe("test-model");
    expect(body.models).toContainEqual({ id: "vision-model", name: "vision-model", reasoning: false, image: true });
    expect(body.forwardHeaders).toEqual(["x-user-token"]);
    expect(body.metadataKeys).toEqual(["thread_id"]);
  });

  it("previews the system prompt and tools a new session gets, without keeping a session", async () => {
    const preview = (body: unknown) =>
      fetch(`${h.url}/admin/api/chat/preview`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify(body),
      });
    const requests = h.llm.requests.length;
    const live = h.gateway.hub.stats().liveSessions;
    const res = await preview({ user: "tester" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.model).toBe("test-model");
    expect(body.systemPrompt.startsWith(h.prompt.text)).toBe(true);
    expect(body.systemPrompt).toContain("Current user: tester");
    expect(body.systemPrompt).toContain("<cwd>\n/workspace\n</cwd>");
    expect(body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["read", "bash", "AskUserQuestion"]));
    expect(body.tools.find((t: any) => t.name === "bash").parameters).toMatchObject({ required: ["command"] });
    expect(h.llm.requests.length).toBe(requests);
    expect(h.gateway.hub.stats().liveSessions).toBe(live);
    expect((await preview({})).status).toBe(400);
    expect((await preview({ user: "tester", model: "nope" })).status).toBe(400);
  });

  it("cancels the active turn and keeps it in the history", async () => {
    const first = (await (await chat({ user: "tester", input: "hi" })).json()) as any;
    const id2 = first.id.replace(/_1$/, "_2");
    h.llm.enqueue({ textChunks: Array.from({ length: 50 }, (_, i) => `c${i} `), chunkDelayMs: 50 });
    const streaming = chat({ user: "tester", input: "long", stream: true, previous_response_id: first.id }).then((r) => r.text());
    const cancel = () =>
      fetch(`${h.url}/admin/api/chat/${id2}/cancel?user=tester`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` } });
    let res = await cancel();
    for (let i = 0; i < 40 && res.status === 404; i++) {
      await new Promise((r) => setTimeout(r, 50));
      res = await cancel();
    }
    expect(res.status).toBe(200);
    const end = last(parseSse(await streaming));
    expect(end.type).toBe("response.incomplete");
    expect((end.data.response as any).incomplete_details).toEqual({ reason: "user_cancelled" });
    expect((await cancel()).status).toBe(409);
  });
});
