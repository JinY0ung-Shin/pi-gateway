import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "../../src/prompts/default-prompt.js";
import { analyzePrompt, buildPromptVars, renderPrompt } from "../../src/prompts/render.js";
import { adminHeaders, buildHarness, cleanupTempDirs, type Harness, loginCookie } from "./helpers.js";

const input = (user = "alice") => ({
  principal: user,
  user,
  model: "test-model",
  sessionId: "s1",
  now: new Date("2026-10-16T03:04:05Z"),
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("prompt rendering", () => {
  it("알려진 변수만 치환하고 나머지는 그대로 둔다", () => {
    const vars = buildPromptVars(input(), "Korean", "Asia/Seoul");
    const text = renderPrompt("{{USER}}|{{DATE}}|{{DATETIME}}|{{WORKSPACE}}|{{MODEL}}|{{LANGUAGE}}|{{FOO}}|{{ USER }}|{{user}}", vars);
    // 변수 이름은 대문자만 인식한다 (공백은 허용)
    expect(text).toBe("alice|2026-10-16|2026-10-16 12:04 (Asia/Seoul)|/workspace|test-model|Korean|{{FOO}}|alice|{{user}}");
    expect(analyzePrompt("{{USER}} {{FOO}} {{MODEL}}")).toEqual({ used: ["USER", "MODEL"], unknown: ["{{FOO}}"] });
  });

  it("기본 프롬프트는 sandbox 지침과 AskUserQuestion 지침을 담고 pi 문서 경로는 없다", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("{{WORKSPACE}}");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("AskUserQuestion");
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Call it alone/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/cannot see files inside the sandbox/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/Do not read, list or show files elsewhere/);
    expect(DEFAULT_SYSTEM_PROMPT).not.toMatch(/node_modules|Pi documentation/);
  });
});

describe("PromptManager", () => {
  it("배포본이 없으면 기본 프롬프트 스냅샷을 준다", async () => {
    h = await buildHarness();
    const snap = h.prompts.snapshotForSession(input());
    expect(snap.ref.name).toBeNull();
    expect(snap.ref.version).toBeNull();
    expect(snap.ref.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(snap.text).toContain("/workspace");
    expect(snap.text).toContain("Reply in Korean");
    expect(snap.text).not.toContain("{{");
    expect(snap.text).toMatch(/Files you create there are kept between conversations with this user/);
  });

  it("버전 관리: 같은 내용 422, append-only", async () => {
    h = await buildHarness();
    const created = h.prompts.create({ name: "ops", content: "Hello {{USER}}", description: "운영" }, "jin");
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    const v2 = h.prompts.addVersion("ops", { content: "Hi {{USER}} on {{MODEL}}", message: "인사 변경" }, "jin");
    expect(v2.version).toBe(2);
    expect(() => h.prompts.addVersion("ops", { content: "Hi {{USER}} on {{MODEL}}" }, "jin")).toThrow(
      expect.objectContaining({ status: 422, code: "no_change" }),
    );
    expect(() => h.db.prepare("UPDATE prompt_versions SET content = 'x' WHERE name = 'ops'").run()).toThrow(/append-only/);
    expect(() => h.prompts.create({ name: "ops", content: "dup" })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => h.prompts.create({ name: "bad name!", content: "x" })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("배포·롤백·초기화", async () => {
    h = await buildHarness();
    h.prompts.create({ name: "ops", content: "v1 for {{USER}} {{UNKNOWN}}" });
    h.prompts.addVersion("ops", { content: "v2 for {{USER}}" });
    const start = h.prompts.live();
    expect(start.isDefault).toBe(true);

    const d2 = h.prompts.deploy("ops", { version: 2 }, "jin");
    expect(d2.deployment?.action).toBe("deploy");
    expect(d2.live.version).toBe(2);
    expect(h.prompts.snapshotForSession(input("bob"))).toMatchObject({ text: "v2 for bob", ref: { name: "ops", version: 2 } });

    const d1 = h.prompts.deploy("ops", { version: 1, note: "되돌림" });
    expect(d1.deployment?.action).toBe("rollback");
    expect(h.prompts.snapshotForSession(input("bob")).text).toBe("v1 for bob {{UNKNOWN}}");

    // 이미 배포된 버전을 다시 배포하면 아무것도 바꾸지 않는다
    expect(h.prompts.deploy("ops", { version: 1 }).deployment).toBeNull();

    const reset = h.prompts.reset({});
    expect(reset.live.isDefault).toBe(true);
    expect(h.prompts.deployments().map((d) => d.action)).toEqual(["reset", "rollback", "deploy"]);
    expect(() => h.prompts.deploy("ops", { version: 9 })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("미리보기는 임의 내용·저장된 버전·현재 배포본을 렌더링한다", async () => {
    h = await buildHarness();
    h.prompts.create({ name: "ops", content: "saved {{MODEL}}" });
    expect(h.prompts.render({ content: "x {{USER}} {{NOPE}}", user: "carol", model: "m1" })).toMatchObject({
      text: "x carol {{NOPE}}",
      used: ["USER"],
      unknown: ["{{NOPE}}"],
    });
    expect(h.prompts.render({ name: "ops", model: "m2" }).text).toBe("saved m2");
    expect(h.prompts.render({}).text).toContain("/workspace");
  });
});

describe("prompt admin API", () => {
  it("쿠키 세션으로 만들기·버전·배포·이력을 처리한다", async () => {
    h = await buildHarness();
    const cookie = await loginCookie(h.app);
    const headers = { cookie, "x-admin-request": "1", "content-type": "application/json" };

    let res = await h.app.inject({ method: "POST", url: "/admin/api/prompts", headers, payload: { name: "ops", content: "A {{USER}}" } });
    expect(res.statusCode).toBe(201);
    res = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts/ops/versions",
      headers,
      payload: { content: "B {{USER}}", message: "두번째" },
    });
    expect(res.statusCode).toBe(201);

    const list = (await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: { cookie } })).json();
    expect(list.prompts[0]).toMatchObject({ name: "ops", latestVersion: 2, versionCount: 2, liveVersion: null });
    expect(list.defaultContent).toContain("{{WORKSPACE}}");

    res = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts/ops/deploy",
      headers,
      payload: { version: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().live).toMatchObject({ name: "ops", version: 2 });


    res = await h.app.inject({ method: "POST", url: "/admin/api/prompt-render", headers, payload: { name: "ops", version: 2, user: "dave" } });
    expect(res.json().text).toBe("B dave");

    res = await h.app.inject({ method: "GET", url: "/admin/api/prompt-deployments", headers: { cookie } });
    expect(res.json().deployments).toHaveLength(1);

    res = await h.app.inject({ method: "POST", url: "/admin/api/prompt-live/reset", headers, payload: {} });
    expect(res.json().live.isDefault).toBe(true);
  });

  it("Bearer로도 쓸 수 있고 큰 내용은 400으로 거절한다", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts",
      headers: { ...adminHeaders, "content-type": "application/json" },
      payload: { name: "big", content: "x".repeat(200_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });
});

afterAll(cleanupTempDirs);
