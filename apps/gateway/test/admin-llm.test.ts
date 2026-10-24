import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAdminRoutes } from "../src/admin/index.js";
import { type Harness, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";
const admin = { authorization: `Bearer ${ADMIN_KEY}` };

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY }, overrides: { registerAdminRoutes } });
});
afterAll(async () => {
  await h.close();
});

const getLlm = async () => (await (await fetch(`${h.url}/admin/api/llm`, { headers: admin })).json()) as any;
const putLlm = (body: unknown) =>
  fetch(`${h.url}/admin/api/llm`, { method: "PUT", headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify(body) });
const settingsWith = async (patch: Record<string, unknown>) => ({ ...(await getLlm()).settings, ...patch });
const lastAuth = () => h.llm.headers.at(-1)!.authorization;

describe("/admin/api/llm", () => {
  it("never returns the API key, applies a new key to new and live sessions, and keeps it when omitted", async () => {
    let view = await getLlm();
    expect(view).toMatchObject({ configured: true, apiKeySet: false, settings: { defaultModel: "test-model" } });
    expect(view.settings.apiKey).toBeUndefined();

    expect((await putLlm(await settingsWith({ apiKey: "key-one" }))).status).toBe(200);
    const first = await h.post({ input: "remember: blue" });
    expect(lastAuth()).toBe("Bearer key-one");

    // 메모리에 있는 세션도 다음 턴부터 새 키를 쓰고, 기록은 그대로다
    expect((await putLlm(await settingsWith({ apiKey: "key-two" }))).status).toBe(200);
    const next = await h.post({ input: "what color?", previous_response_id: first.json.id });
    expect(next.status).toBe(200);
    expect(lastAuth()).toBe("Bearer key-two");
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("remember: blue");

    // apiKey를 빼면 지금 키를 유지한다
    expect((await putLlm(await settingsWith({}))).status).toBe(200);
    view = await getLlm();
    expect(view.apiKeySet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("key-two");
    await h.post({ input: "hi" });
    expect(lastAuth()).toBe("Bearer key-two");
  });

  it("rejects invalid settings and lists the new models right away", async () => {
    const bad = await putLlm(await settingsWith({ defaultModel: "nope" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("invalid_llm_settings");

    const session = await h.post({ model: "think-model", input: "hi" });
    const models = [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }, { id: "new-model", contextWindow: 8000, maxTokens: 1000 }];
    expect((await putLlm(await settingsWith({ models, defaultModel: "new-model" }))).status).toBe(200);
    const list = (await (await fetch(`${h.url}/v1/models`, { headers: { authorization: "Bearer alice-key-0123456789abcdef" } })).json()) as any;
    expect(list.data.map((m: { id: string }) => m.id)).toEqual(["test-model", "new-model"]);
    expect((await h.post({ input: "hi" })).json.model).toBe("new-model");

    // 지운 모델의 세션은 이어갈 수 없다
    const cont = await h.post({ input: "again", previous_response_id: session.json.id });
    expect(cont.status).toBe(400);
    expect(cont.json.error.code).toBe("model_not_configured");
  });
});

describe("without LLM settings", () => {
  it("returns 503 llm_not_configured", async () => {
    const empty = await startHarness({ llm: null });
    try {
      const res = await empty.post({ input: "hi" });
      expect(res.status).toBe(503);
      expect(res.json.error.code).toBe("llm_not_configured");
    } finally {
      await empty.close();
    }
  });
});
