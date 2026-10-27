import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelRuntime } from "../src/agent/runtime.js";
import { openDatabase } from "../src/db.js";
import { startFakeLlm } from "./fixtures/fake-llm.js";
import { ALICE_KEY, type Harness, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";
const admin = { authorization: `Bearer ${ADMIN_KEY}` };

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY } });
});
afterAll(async () => {
  await h.close();
});

const getLlm = async () => (await (await fetch(`${h.url}/admin/api/llm`, { headers: admin })).json()) as any;
const send = (method: string, path: string, body: unknown) =>
  fetch(`${h.url}/admin/api${path}`, { method, headers: { ...admin, "content-type": "application/json" }, body: JSON.stringify(body) });
const putLlm = (body: unknown) => send("PUT", "/llm", body);
const postJson = async (path: string, body: unknown) => (await (await send("POST", path, body)).json()) as any;
/** 지금 설정에서 첫 서버(test)만 바꾼 PUT 본문. 화면처럼 apiKeySet은 빼고 보낸다. */
const withServer = async (patch: Record<string, unknown>, defaultModel?: string) => {
  const { settings } = await getLlm();
  const [{ apiKeySet: _, ...first }, ...rest] = settings.servers;
  return { servers: [{ ...first, ...patch }, ...rest], defaultModel: defaultModel ?? settings.defaultModel };
};
const lastAuth = () => h.llm.headers.at(-1)!.authorization;
const models = async () =>
  ((await (await fetch(`${h.url}/v1/models`, { headers: { authorization: `Bearer ${ALICE_KEY}` } })).json()) as any).data;

describe("/admin/api/llm", () => {
  it("never returns the API key, applies a new key to new and live sessions, and keeps it when omitted", async () => {
    let view = await getLlm();
    expect(view).toMatchObject({ configured: true, settings: { defaultModel: "test-model", servers: [{ id: "test", apiKeySet: false }] } });
    expect(view.settings.servers[0].apiKey).toBeUndefined();

    expect((await putLlm(await withServer({ apiKey: "key-one" }))).status).toBe(200);
    const first = await h.post({ input: "remember: blue" });
    expect(lastAuth()).toBe("Bearer key-one");

    // 메모리에 있는 세션도 다음 턴부터 새 키를 쓰고, 기록은 그대로다
    expect((await putLlm(await withServer({ apiKey: "key-two" }))).status).toBe(200);
    const next = await h.post({ input: "what color?", previous_response_id: first.json.id });
    expect(next.status).toBe(200);
    expect(lastAuth()).toBe("Bearer key-two");
    expect(JSON.stringify(h.llm.requests.at(-1)!.messages)).toContain("remember: blue");

    // apiKey를 빼면 지금 키를 유지한다
    expect((await putLlm(await withServer({}))).status).toBe(200);
    view = await getLlm();
    expect(view.settings.servers[0].apiKeySet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("key-two");
    await h.post({ input: "hi" });
    expect(lastAuth()).toBe("Bearer key-two");

    // ""이면 지운다
    expect((await putLlm(await withServer({ apiKey: "" }))).status).toBe(200);
    expect((await getLlm()).settings.servers[0].apiKeySet).toBe(false);
  });

  it("rejects invalid settings and lists the new models right away", async () => {
    const bad = await putLlm(await withServer({}, "nope"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe("invalid_llm_settings");

    const session = await h.post({ model: "think-model", input: "hi" });
    const list = [
      { id: "test-model", contextWindow: 32000, maxTokens: 4096 },
      { id: "new-model", contextWindow: 8000, maxTokens: 1000 },
    ];
    expect((await putLlm(await withServer({ models: list }, "new-model"))).status).toBe(200);
    expect((await models()).map((m: { id: string }) => m.id)).toEqual(["test-model", "new-model"]);
    expect((await h.post({ input: "hi" })).json.model).toBe("new-model");

    // 지운 모델의 세션은 이어갈 수 없다
    const cont = await h.post({ input: "again", previous_response_id: session.json.id });
    expect(cont.status).toBe(400);
    expect(cont.json.error.code).toBe("model_not_configured");
  });

  it("serves models from several servers, each with its own key", async () => {
    const other = await startFakeLlm();
    try {
      const base = await withServer({});
      const second = {
        id: "second",
        api: "openai-completions",
        baseUrl: other.url,
        apiKey: "second-key",
        models: [{ id: "second-model", contextWindow: 8000, maxTokens: 1000 }],
      };
      expect((await putLlm({ ...base, servers: [...base.servers, second] })).status).toBe(200);
      expect(await models()).toContainEqual({ id: "second-model", object: "model", owned_by: "second" });
      expect(await models()).toContainEqual({ id: "test-model", object: "model", owned_by: "test" });

      const res = await h.post({ model: "second-model", input: "hi" });
      expect(res.status).toBe(200);
      expect(other.requests.at(-1)!.model).toBe("second-model");
      expect(other.headers.at(-1)!.authorization).toBe("Bearer second-key");

      // 키를 빼고 다시 저장해도 서버마다 자기 키를 유지한다
      const again = await getLlm();
      expect(again.settings.servers.map((s: { id: string; apiKeySet: boolean }) => [s.id, s.apiKeySet])).toEqual([
        ["test", false],
        ["second", true],
      ]);
      const servers = again.settings.servers.map(({ apiKeySet: _, ...s }: { apiKeySet: boolean }) => s);
      expect((await putLlm({ servers, defaultModel: again.settings.defaultModel })).status).toBe(200);
      await h.post({ model: "second-model", input: "hi" });
      expect(other.headers.at(-1)!.authorization).toBe("Bearer second-key");

      // 모델 id는 서버끼리 겹칠 수 없다
      const dup = await putLlm({ servers: [servers[0], { ...servers[1], models: [{ id: "test-model", contextWindow: 8000, maxTokens: 1000 }] }], defaultModel: "test-model" });
      expect(dup.status).toBe(400);
      expect(((await dup.json()) as any).error.message).toContain("unique across servers: test-model");

      // 서버를 지우면 그 모델도 사라진다
      expect((await putLlm({ servers: [servers[0]], defaultModel: "test-model" })).status).toBe(200);
      expect((await models()).map((m: { id: string }) => m.id)).not.toContain("second-model");
      expect((await h.post({ model: "second-model", input: "hi" })).status).toBe(400);
    } finally {
      await other.close();
    }
  });

  it("probes a server for its models, with the stored key when none is given", async () => {
    expect((await putLlm(await withServer({ apiKey: "probe-key" }))).status).toBe(200);
    h.llm.models.splice(0, h.llm.models.length, { id: "test-model", max_model_len: 32768 }, { id: "Qwen/Qwen3-8B" });

    const ok = await postJson("/llm/probe", { server: { id: "test", api: "openai-completions", baseUrl: h.llm.url, headers: { "X-Team": "ai" } } });
    expect(ok).toMatchObject({ ok: true, models: [{ id: "test-model", contextWindow: 32768 }, { id: "Qwen/Qwen3-8B" }] });
    expect(ok.models[1].contextWindow).toBeUndefined();
    expect(h.llm.modelRequests.at(-1)!).toMatchObject({ authorization: "Bearer probe-key", "x-team": "ai" });

    await postJson("/llm/probe", { server: { id: "test", api: "openai-completions", baseUrl: h.llm.url, apiKey: "typed-key" } });
    expect(h.llm.modelRequests.at(-1)!.authorization).toBe("Bearer typed-key");

    // anthropic-messages는 {baseUrl}/v1/models에 x-api-key로 묻는다
    const origin = h.llm.url.replace(/\/v1$/, "");
    expect(await postJson("/llm/probe", { server: { id: "test", api: "anthropic-messages", baseUrl: origin } })).toMatchObject({ ok: true });
    expect(h.llm.modelRequests.at(-1)!).toMatchObject({ "x-api-key": "probe-key", "anthropic-version": "2023-06-01" });

    expect(await postJson("/llm/probe", { server: { api: "openai-completions", baseUrl: `${origin}/nope` } })).toMatchObject({ ok: false, error: "HTTP 404" });
    const down = await postJson("/llm/probe", { server: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1" } });
    expect(down.ok).toBe(false);
    expect(down.error).toContain("fetch failed");

    const invalid = await send("POST", "/llm/probe", { server: { api: "openai-completions", baseUrl: "not a url" } });
    expect(invalid.status).toBe(400);
  });

  it("status checks every LLM server and names configured models the server lacks", async () => {
    const base = await withServer({});
    const down = { id: "down", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", models: [{ id: "down-model", contextWindow: 8000, maxTokens: 1000 }] };
    expect((await putLlm({ ...base, servers: [base.servers[0], down] })).status).toBe(200);
    const configured = base.servers[0].models.map((m: { id: string }) => m.id);
    h.llm.models.splice(0, h.llm.models.length, { id: configured[0] });

    const status = (await (await fetch(`${h.url}/admin/api/status`, { headers: admin })).json()) as any;
    expect(status.services.llm).toEqual([
      { id: "test", ok: true, durationMs: expect.any(Number), models: configured.length, missingModels: configured.slice(1) },
      { id: "down", ok: false, durationMs: expect.any(Number), error: expect.stringContaining("fetch failed"), models: 1, missingModels: [] },
    ]);
    expect(status.services.sandboxd).toMatchObject({ ok: true });
    expect(status.services.broker).toMatchObject({ ok: expect.any(Boolean) });
    expect((await putLlm(base)).status).toBe(200);
  });

  it("tests a model through pi, also before it is saved", async () => {
    const { servers } = (await withServer({})) as { servers: Record<string, unknown>[] };
    h.llm.enqueue({ text: "OK" });
    const ok = await postJson("/llm/test", { server: servers[0], model: "test-model" });
    expect(ok).toMatchObject({ ok: true, text: "OK", thinking: false, stopReason: "stop" });
    expect(h.llm.requests.at(-1)!).toMatchObject({ model: "test-model", max_tokens: 32 });

    // 저장하지 않은 모델도 시험할 수 있다
    h.llm.enqueue({ reasoning: "hmm", text: "OK" });
    const fresh = await postJson("/llm/test", {
      server: { ...servers[0], models: [{ id: "unsaved-model", contextWindow: 8000, maxTokens: 1000, reasoning: true }] },
      model: "unsaved-model",
    });
    expect(fresh).toMatchObject({ ok: true, thinking: true });
    expect(h.llm.requests.at(-1)!).toMatchObject({ model: "unsaved-model", max_tokens: 512 });

    h.llm.enqueue({ error: { status: 500, body: { error: { message: "model is loading" } } } });
    const failed = await postJson("/llm/test", { server: servers[0], model: "test-model" });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("model is loading");

    expect((await send("POST", "/llm/test", { server: servers[0], model: "nope" })).status).toBe(400);
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

describe("stored settings from before several servers", () => {
  it("become one server named upstream", async () => {
    const db = openDatabase(":memory:");
    await createModelRuntime(db);
    const old = {
      api: "openai-completions",
      baseUrl: "http://vllm.internal:8000/v1",
      apiKey: "k",
      headers: {},
      compat: {},
      models: [{ id: "m", contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text"] }],
      defaultModel: "m",
    };
    db.prepare("INSERT INTO llm_settings (id, settings_json, updated_at) VALUES (1, ?, ?)").run(JSON.stringify(old), "2026-10-01T00:00:00.000Z");
    db.prepare("DELETE FROM schema_migrations WHERE module = 'llm' AND step = 1").run();

    const models = await createModelRuntime(db);
    expect(models.current()!.settings).toMatchObject({ servers: [{ id: "upstream", baseUrl: old.baseUrl, apiKey: "k", models: [{ id: "m" }] }], defaultModel: "m" });
    expect(models.get("m")?.provider).toBe("upstream");
    db.close();
  });
});
