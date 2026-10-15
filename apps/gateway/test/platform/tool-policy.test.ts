import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ToolCatalog, ToolCatalogEntry } from "../../src/contracts.js";
import { openDatabase } from "../../src/db.js";
import { mcpWildcardFor, ToolPolicyService } from "../../src/tool-policy/index.js";
import { adminHeaders, buildHarness, cleanupTempDirs, type Harness, loginCookie } from "./helpers.js";

const CATALOG: ToolCatalogEntry[] = [
  { name: "read", description: "Read files", provider: "sandbox", runsIn: "sandbox", enabledByDefault: true, required: true },
  { name: "bash", description: "Run commands", provider: "sandbox", runsIn: "sandbox", enabledByDefault: true },
  { name: "AskUserQuestion", description: "Ask the user", provider: "ask-user", runsIn: "gateway", enabledByDefault: true },
  { name: "experimental", description: "Off by default", provider: "extra", runsIn: "gateway", enabledByDefault: false },
  { name: "mcp__github__*", description: "GitHub tools", provider: "mcp-broker", runsIn: "broker", enabledByDefault: true, dynamic: true },
];
const catalog: ToolCatalog = { list: async () => CATALOG };

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("ToolPolicyService", () => {
  it("required는 항상 켜짐, 설정 → MCP 서버 대표 설정 → 기본값 순으로 본다", () => {
    const policy = new ToolPolicyService(openDatabase(":memory:"));
    const r0 = policy.revision();
    expect(policy.isEnabled(CATALOG[0]!, "alice")).toBe(true);
    expect(policy.isEnabled(CATALOG[3]!, "alice")).toBe(false);
    policy.set("read", false, "admin"); // 정책에 값이 있어도 required는 끌 수 없다
    expect(policy.isEnabled(CATALOG[0]!, "alice")).toBe(true);
    policy.set("bash", false, "admin");
    expect(policy.isEnabled(CATALOG[1]!, "alice")).toBe(false);
    expect(policy.revision()).toBe(r0 + 2);

    const tool = { name: "mcp__github__create_issue", provider: "mcp-broker", enabledByDefault: true };
    expect(policy.isEnabled(tool, "alice")).toBe(true);
    policy.set("mcp__github__*", false, "admin");
    expect(policy.isEnabled(tool, "alice")).toBe(false);
    policy.set("mcp__github__create_issue", true, "admin"); // 도구별 설정이 서버 설정보다 우선
    expect(policy.isEnabled(tool, "alice")).toBe(true);

    expect(policy.reset("bash")).toBe(true);
    expect(policy.reset("bash")).toBe(false);
    expect(policy.isEnabled(CATALOG[1]!, "alice")).toBe(true);
    expect(mcpWildcardFor("mcp__a-b__x")).toBe("mcp__a-b__*");
    expect(mcpWildcardFor("mcp__a__*")).toBeUndefined();
    expect(mcpWildcardFor("bash")).toBeUndefined();
  });

  it("여러 인스턴스가 같은 DB를 보면 결과가 같다", () => {
    const db = openDatabase(":memory:");
    const a = new ToolPolicyService(db);
    const b = new ToolPolicyService(db);
    expect(b.isEnabled(CATALOG[1]!, "x")).toBe(true);
    a.set("bash", false, "admin");
    expect(b.isEnabled(CATALOG[1]!, "x")).toBe(false);
    expect(b.revision()).toBe(a.revision());
  });
});

describe("tools admin API", () => {
  it("카탈로그와 현재 상태를 합쳐 보여준다", async () => {
    h = await buildHarness({ tools: catalog });
    h.toolPolicy.set("bash", false, "진영");
    const res = await h.app.inject({ method: "GET", url: "/admin/api/tools", headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalogAvailable).toBe(true);
    const byName = Object.fromEntries(body.tools.map((t: { name: string }) => [t.name, t]));
    expect(byName.read).toMatchObject({ enabled: true, required: true, explicit: false, updatedBy: null });
    expect(byName.bash).toMatchObject({ enabled: false, explicit: true, updatedBy: "진영", runsIn: "sandbox" });
    expect(byName.experimental).toMatchObject({ enabled: false, explicit: false });
    expect(byName["mcp__github__*"]).toMatchObject({ dynamic: true, runsIn: "broker", enabled: true });
  });

  it("PUT: required는 409, 모르는 도구는 404, MCP 대표 이름은 카탈로그에 없어도 허용", async () => {
    h = await buildHarness({ tools: catalog });
    const cookie = await loginCookie(h.app);
    const headers = { cookie, "x-admin-request": "1", "content-type": "application/json" };
    let res = await h.app.inject({ method: "PUT", url: "/admin/api/tools/read", headers, payload: { enabled: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("required");
    res = await h.app.inject({ method: "PUT", url: "/admin/api/tools/unknown", headers, payload: { enabled: false } });
    expect(res.statusCode).toBe(404);
    res = await h.app.inject({ method: "PUT", url: "/admin/api/tools/bash", headers, payload: { enabled: "no" } });
    expect(res.statusCode).toBe(400);

    const before = h.toolPolicy.revision();
    res = await h.app.inject({ method: "PUT", url: "/admin/api/tools/experimental", headers, payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "experimental", enabled: true, explicit: true, updatedBy: "admin" });
    expect(h.toolPolicy.revision()).toBe(before + 1);

    res = await h.app.inject({ method: "PUT", url: `/admin/api/tools/${encodeURIComponent("mcp__jira__*")}`, headers, payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "mcp__jira__*", dynamic: true, enabled: false });
    expect(h.toolPolicy.isEnabled({ name: "mcp__jira__search", provider: "mcp-broker", enabledByDefault: true }, "alice")).toBe(false);

    // 카탈로그에 없는 설정은 orphans로 보인다
    const list = (await h.app.inject({ method: "GET", url: "/admin/api/tools", headers: { cookie } })).json();
    expect(list.orphans.map((o: { name: string }) => o.name)).toEqual(["mcp__jira__*"]);

    res = await h.app.inject({ method: "DELETE", url: "/admin/api/tools/experimental", headers: { cookie, "x-admin-request": "1" } });
    expect(res.json()).toMatchObject({ name: "experimental", enabled: false, explicit: false });
  });

  it("core가 카탈로그·정책을 아직 넘기지 않아도 동작한다", async () => {
    h = await buildHarness({ omitToolPolicy: true });
    const res = await h.app.inject({ method: "GET", url: "/admin/api/tools", headers: adminHeaders });
    expect(res.json()).toMatchObject({ catalogAvailable: false, tools: [] });
    const put = await h.app.inject({
      method: "PUT",
      url: "/admin/api/tools/bash",
      headers: { ...adminHeaders, "content-type": "application/json" },
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(404);
  });
});

afterAll(cleanupTempDirs);
