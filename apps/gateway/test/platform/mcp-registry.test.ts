import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServerConfig } from "@pi-gateway/shared";
import { mergeWithBaseline } from "../../src/mcp-registry/service.js";
import {
  adminHeaders,
  brokerEnv,
  buildHarness,
  cleanupTempDirs,
  dbFilesContain,
  type FakeBroker,
  type Harness,
  loginCookie,
  startFakeBroker,
} from "./helpers.js";

const SECRET = "ghp_SUPER_SECRET_VALUE_123456789";

const sandboxServer = {
  id: "monsemi-frontend",
  runIn: "sandbox",
  scope: "per-session",
  transport: { type: "stdio", command: "node", args: ["/opt/plugins/x/server.js"], env: { THREAD_ID: "{{metadata:THREAD_ID}}" } },
};

const brokerServer = {
  id: "github",
  runIn: "broker",
  transport: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer {{secret:GITHUB_TOKEN}}" } },
};

let broker: FakeBroker;
let h: Harness;

beforeEach(async () => {
  broker = await startFakeBroker();
});
afterEach(async () => {
  await h?.close();
  await broker.close();
});

const json = { "content-type": "application/json" };

describe("MCP registry", () => {
  it("sandbox 서버는 gateway DB에, broker 서버는 broker에 저장하고 목록을 합친다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    let res = await h.app.inject({
      method: "PUT",
      url: "/admin/api/mcp/servers/monsemi-frontend",
      headers: { ...adminHeaders, ...json, "x-admin-actor": encodeURIComponent("진영") },
      payload: { config: sandboxServer },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ store: "sandbox", config: { id: "monsemi-frontend", scope: "per-session" } });

    res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/github", headers: { ...adminHeaders, ...json }, payload: { config: brokerServer } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ store: "broker", missingSecrets: ["GITHUB_TOKEN"] });
    expect(broker.servers.has("github")).toBe(true);

    const list = (await h.app.inject({ method: "GET", url: "/admin/api/mcp/servers", headers: adminHeaders })).json();
    expect(list.broker).toEqual({ available: true });
    expect(list.servers.map((s: { store: string; config: { id: string } }) => [s.config.id, s.store])).toEqual([
      ["github", "broker"],
      ["monsemi-frontend", "sandbox"],
    ]);
    expect(h.mcp.sandboxServers().map((c) => c.id)).toEqual(["monsemi-frontend"]);
  });

  it("검증: sandbox 서버에 secret 자리표시자를 쓰면 400, id가 경로와 다르면 400", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    const bad = {
      ...sandboxServer,
      transport: { type: "stdio", command: "node", env: { T: "{{secret:TOKEN}}" } },
    };
    let res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/monsemi-frontend", headers: { ...adminHeaders, ...json }, payload: { config: bad } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/must not use \{\{secret/);
    res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/other", headers: { ...adminHeaders, ...json }, payload: { config: sandboxServer } });
    expect(res.statusCode).toBe(400);
    res = await h.app.inject({ method: "POST", url: "/admin/api/mcp/validate", headers: { ...adminHeaders, ...json }, payload: { config: brokerServer } });
    expect(res.json()).toEqual({ ok: true, errors: [], requiredSecrets: ["GITHUB_TOKEN"], clearsSecrets: [] });
  });

  it("검증: 저장하면 broker가 지울 비밀키를 알려준다 (실행 대상이 바뀌거나 sandbox로 옮길 때)", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    await h.mcp.upsert(brokerServer, "t");
    await h.mcp.setSecret("github", "GITHUB_TOKEN", { value: SECRET }, "t");
    const clears = async (config: object) => (await h.mcp.validate(config)).clearsSecrets;
    expect(await clears({ ...brokerServer, displayName: "GitHub" })).toEqual([]);
    expect(await clears({ ...brokerServer, transport: { ...brokerServer.transport, url: "https://evil.example.com/mcp" } })).toEqual(["GITHUB_TOKEN"]);
    expect(await clears({ ...sandboxServer, id: "github" })).toEqual(["GITHUB_TOKEN"]);
  });

  it("비밀값은 broker로만 전달되고 gateway DB·로그·응답에는 남지 않는다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    const cookie = await loginCookie(h.app);
    const headers = { cookie, "x-admin-request": "1", ...json };
    const bodies: string[] = [];
    let res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/github", headers, payload: { config: brokerServer } });
    bodies.push(res.body);
    res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/github/secrets/GITHUB_TOKEN", headers, payload: { value: SECRET } });
    expect(res.statusCode).toBe(204);
    bodies.push(res.body);
    expect(broker.secrets.get("github")?.get("GITHUB_TOKEN")).toBe(SECRET);

    for (const [method, url] of [
      ["GET", "/admin/api/mcp/servers"],
      ["POST", "/admin/api/mcp/servers/github/test"],
    ] as const) {
      res = await h.app.inject({ method, url, headers: method === "GET" ? { cookie } : { ...headers }, ...(method === "POST" ? { payload: {} } : {}) });
      expect(res.statusCode).toBe(200);
      bodies.push(res.body);
    }
    const list = (await h.app.inject({ method: "GET", url: "/admin/api/mcp/servers", headers: { cookie } })).json();
    const view = list.servers.find((s: { config: { id: string } }) => s.config.id === "github");
    expect(view.missingSecrets).toEqual([]);
    expect(view.secrets[0]).toMatchObject({ name: "GITHUB_TOKEN" });

    // 잘못된 본문 오류 메시지에도 값이 들어가지 않는다
    res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/github/secrets/bad%20name", headers, payload: { value: SECRET } });
    expect(res.statusCode).toBe(400);
    bodies.push(res.body);

    for (const body of bodies) expect(body).not.toContain(SECRET);
    expect(h.logs.join("\n")).not.toContain(SECRET);
    expect(dbFilesContain(h.dbPath, SECRET)).toBe(false);
  });

  it("sandbox 서버에는 비밀키를 넣을 수 없고, 연결 테스트는 정적 검사만 한다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    await h.mcp.upsert(sandboxServer, "t");
    let res = await h.app.inject({
      method: "PUT",
      url: "/admin/api/mcp/servers/monsemi-frontend/secrets/X",
      headers: { ...adminHeaders, ...json },
      payload: { value: "v" },
    });
    expect(res.statusCode).toBe(400);
    res = await h.app.inject({ method: "POST", url: "/admin/api/mcp/servers/monsemi-frontend/test", headers: { ...adminHeaders, ...json }, payload: {} });
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().note).toMatch(/sandbox/);
  });

  it("runIn을 바꾸면 다른 저장소로 옮기고, 삭제는 어느 쪽이든 찾아서 지운다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    await h.mcp.upsert(sandboxServer, "t");
    const moved = await h.mcp.upsert(
      { ...sandboxServer, runIn: "broker", transport: { type: "http", url: "https://monsemi.example.com/mcp", headers: { Authorization: "Bearer {{secret:T}}" } } },
      "t",
    );
    expect(moved.store).toBe("broker");
    expect(h.mcp.store.get("monsemi-frontend")).toBeUndefined();
    expect(broker.servers.has("monsemi-frontend")).toBe(true);
    await h.mcp.upsert(sandboxServer, "t");
    expect(broker.servers.has("monsemi-frontend")).toBe(false);
    const res = await h.app.inject({ method: "DELETE", url: "/admin/api/mcp/servers/monsemi-frontend", headers: adminHeaders });
    expect(res.statusCode).toBe(204);
    expect((await h.app.inject({ method: "DELETE", url: "/admin/api/mcp/servers/nope", headers: adminHeaders })).statusCode).toBe(404);
  });

  it("brokerServersFor는 내부 JWT로 broker 데이터 평면을 부르고, 실패하면 빈 목록이다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    await h.mcp.upsert({ ...brokerServer, id: "docs", transport: { type: "http", url: "https://docs.example.com/mcp", headers: {} } }, "t");
    await h.mcp.upsert(brokerServer, "t"); // 비밀키가 없어서 보이지 않는다
    expect(await h.mcp.brokerServersFor("alice", "sess-1")).toEqual([{ id: "docs", timeoutSec: 120 }]);
    await broker.close();
    expect(await h.mcp.brokerServersFor("alice", "sess-1")).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/could not list MCP servers from the broker/);
    broker = await startFakeBroker(); // afterEach가 닫을 수 있게
  });

  it("forwardHeaders는 broker 서버 설정의 {{ctx.header}} 이름이고, 서버를 바꾸면 다시 읽는다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    expect(await h.mcp.forwardHeaders()).toEqual([]);
    const foo = { ...brokerServer, id: "foo", transport: { type: "http", url: "https://foo.example.com/mcp", headers: { "X-Api-Key": "{{ctx.header:X-Foo-Token}}" } } };
    await h.mcp.upsert(foo, "t");
    expect(await h.mcp.forwardHeaders()).toEqual(["x-foo-token"]);
    await h.mcp.remove("foo", "t");
    expect(await h.mcp.forwardHeaders()).toEqual([]);
  });

  it("sandbox 서버에 리터럴 자격증명을 넣으면 400이고, broker+{{secret}}을 쓰라고 알려준다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    const literal = { ...sandboxServer, transport: { ...sandboxServer.transport, env: { GITHUB_TOKEN: "ghp_literal_value_123" } } };
    let res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/monsemi-frontend", headers: { ...adminHeaders, ...json }, payload: { config: literal } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/GITHUB_TOKEN.*literal credential.*runIn=broker/);
    expect(h.mcp.store.get("monsemi-frontend")).toBeUndefined();
    res = await h.app.inject({ method: "POST", url: "/admin/api/mcp/validate", headers: { ...adminHeaders, ...json }, payload: { config: literal } });
    expect(res.json().ok).toBe(false);
    expect(res.json().errors.join(" ")).toMatch(/runIn=broker/);
    // broker 서버는 http만 쓴다
    res = await h.app.inject({
      method: "POST",
      url: "/admin/api/mcp/validate",
      headers: { ...adminHeaders, ...json },
      payload: { config: { id: "x", runIn: "broker", transport: { type: "stdio", command: "node", args: ["x.js"] } } },
    });
    expect(res.json().errors.join(" ")).toMatch(/broker servers must use the http transport/);
  });

  it("broker가 안 될 때 broker를 확인해야 하는 변경은 503으로 실패하고 아무것도 바꾸지 않는다", async () => {
    h = await buildHarness({ env: brokerEnv(broker.url) });
    await h.mcp.upsert(brokerServer, "t");
    await h.mcp.upsert({ ...sandboxServer, id: "new-one" }, "t");
    broker.setDown(true);
    try {
      // sandbox로 옮기기: broker에 같은 id가 있는지 확인할 수 없으므로 만들지 않는다
      await expect(h.mcp.upsert({ ...sandboxServer, id: "github" }, "t")).rejects.toMatchObject({ status: 503, code: "broker_unavailable" });
      expect(h.mcp.store.get("github")).toBeUndefined();
      await expect(h.mcp.remove("github", "t")).rejects.toMatchObject({ status: 503 });
      await expect(h.mcp.setPluginServersEnabled("p@m", false, "t")).rejects.toMatchObject({ status: 503 });
      await expect(h.mcp.removePluginServers("p@m", "t")).rejects.toMatchObject({ status: 503 });
      // 새 id의 sandbox 서버도 broker에 같은 id가 있는지 확인해야 하므로 만들지 않는다
      let res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/brand-new", headers: { ...adminHeaders, ...json }, payload: { config: { ...sandboxServer, id: "brand-new" } } });
      expect(res.statusCode).toBe(503);
      expect(h.mcp.store.get("brand-new")).toBeUndefined();
      // 이미 sandbox에 있는 서버를 고칠 때는 broker에 묻지 않는다
      const asked = broker.refused.length;
      res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/new-one", headers: { ...adminHeaders, ...json }, payload: { config: { ...sandboxServer, id: "new-one", description: "edited" } } });
      expect(res.statusCode).toBe(200);
      expect(broker.refused.length).toBe(asked);
      // broker에 있던 id를 sandbox로 옮기는 것은 503 (두 저장소에 같은 id가 생긴다)
      res = await h.app.inject({ method: "PUT", url: "/admin/api/mcp/servers/github", headers: { ...adminHeaders, ...json }, payload: { config: { ...sandboxServer, id: "github" } } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.message).toMatch(/not applied/);
      // sandbox 서버 삭제도 broker 없이 된다
      expect((await h.app.inject({ method: "DELETE", url: "/admin/api/mcp/servers/new-one", headers: adminHeaders })).statusCode).toBe(204);
      // plugin 기록상 broker 서버가 없으면 broker에 묻지 않는다
      await expect(h.mcp.setPluginServersEnabled("p@m", false, "t", { broker: false })).resolves.toBeUndefined();
      await expect(h.mcp.removePluginServers("p@m", "t", { broker: false })).resolves.toEqual([]);
      // 목록은 sandbox 서버만 보여주고 이유를 알려준다
      const list = (await h.app.inject({ method: "GET", url: "/admin/api/mcp/servers", headers: adminHeaders })).json();
      expect(list.broker).toMatchObject({ available: false });
    } finally {
      broker.setDown(false);
    }
    expect(broker.servers.has("github")).toBe(true);
  });

  describe("mergeWithBaseline (plugin 업데이트 병합)", () => {
    const make = (version: string, env: Record<string, string>, extra: Record<string, unknown> = {}) =>
      McpServerConfig.parse({
        id: "srv",
        runIn: "sandbox",
        scope: "per-user",
        source: { kind: "plugin", pluginId: "p@m", version },
        transport: { type: "stdio", command: "node", args: [`/opt/plugins/m/p/${version}/s.js`], env: { CLAUDE_PLUGIN_ROOT: `/opt/plugins/m/p/${version}`, ...env } },
        ...extra,
      });

    it("관리자가 바꾼 값만 유지하고 plugin이 바꾼 값은 반영한다", () => {
      const baseline = make("1", { LOG: "json", MODE: "a", OLD: "x" });
      const current = make("1", { LOG: "json", MODE: "admin", SERVICE_URL: "http://svc" }, { enabled: false }); // MODE 변경, SERVICE_URL 추가, OLD 삭제
      const mapped = make("2", { LOG: "text", MODE: "b", OLD: "x", NEW: "n" });
      const merged = mergeWithBaseline(baseline, current, mapped);
      expect(merged.enabled).toBe(false);
      expect(merged.transport).toMatchObject({
        args: ["/opt/plugins/m/p/2/s.js"],
        env: { CLAUDE_PLUGIN_ROOT: "/opt/plugins/m/p/2", LOG: "text", MODE: "admin", SERVICE_URL: "http://svc", NEW: "n" },
      });
      expect((merged.transport as { env: Record<string, string> }).env.OLD).toBeUndefined(); // 관리자가 지웠고 plugin 값은 그대로
    });
  });
});

afterAll(cleanupTempDirs);
