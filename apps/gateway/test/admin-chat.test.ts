import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../src/admin/index.js";
import { type Harness, last, parseSse, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY }, overrides: { registerAdminRoutes } });
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
    expect((await noUser.json()).error.message).toBe("user is required");
  });
});
