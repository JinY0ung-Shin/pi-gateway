import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secretVariants } from "../src/redact.js";
import { startTestBroker, type TestBroker } from "./helpers.js";

const httpServer = (id: string, extra: Record<string, unknown> = {}) => ({
  runIn: "broker",
  displayName: `Server ${id}`,
  transport: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer {{secret:TOKEN}}" } },
  ...extra,
});

describe("admin plane", () => {
  let tb: TestBroker;
  beforeAll(async () => {
    tb = await startTestBroker();
  });
  afterAll(async () => {
    await tb.close();
  });

  it("서버를 만들고(201) 고치고(200) 조회하고 지운다(204)", async () => {
    const created = await tb.admin("PUT", "/admin/servers/crud", httpServer("crud"));
    expect(created.status).toBe(201);
    expect(created.json().missingSecrets).toEqual(["TOKEN"]);
    const updated = await tb.admin("PUT", "/admin/servers/crud", httpServer("crud", { description: "changed" }));
    expect(updated.status).toBe(200);
    expect(updated.json().config.description).toBe("changed");
    const list = await tb.admin("GET", "/admin/servers");
    expect(list.json().servers.map((s: { config: { id: string } }) => s.config.id)).toContain("crud");
    expect((await tb.admin("DELETE", "/admin/servers/crud")).status).toBe(204);
    expect((await tb.admin("GET", "/admin/servers/crud")).status).toBe(404);
    expect((await tb.admin("DELETE", "/admin/servers/crud")).status).toBe(404);
  });

  it("잘못된 설정을 400으로 거부한다", async () => {
    const cases: [string, unknown][] = [
      ["sandbox runIn", httpServer("x", { runIn: "sandbox" })],
      ["body id mismatch", { ...httpServer("x"), id: "other" }],
      ["literal credential", httpServer("x", { transport: { type: "http", url: "http://h/mcp", headers: { Authorization: "Bearer raw" } } })],
      ["npx", httpServer("x", { transport: { type: "stdio", command: "npx", args: ["-y", "pkg"] } })],
      ["unknown placeholder", httpServer("x", { transport: { type: "http", url: "http://h/{{nope}}", headers: {} } })],
      ["shared stdio with user", httpServer("x", { transport: { type: "stdio", command: "node", env: { U: "{{user}}" } } })],
      ["not an object", [1, 2]],
    ];
    for (const [label, body] of cases) {
      const res = await tb.admin("PUT", "/admin/servers/x", body);
      expect(res.status, label).toBe(400);
      expect(res.json().error.code, label).toBe("invalid_request");
    }
    expect((await tb.admin("PUT", "/admin/servers/servers", httpServer("servers"))).status).toBe(400);
  });

  it("비밀키는 쓰기 전용이고 이름·fingerprint만 보인다", async () => {
    await tb.admin("PUT", "/admin/servers/wo", httpServer("wo"));
    const put = await tb.admin("PUT", "/admin/servers/wo/secrets/TOKEN", { value: "tok-abcdef-123456" });
    expect(put.status).toBe(204);
    expect(put.text).toBe("");
    const view = (await tb.admin("GET", "/admin/servers/wo")).json();
    expect(view.missingSecrets).toEqual([]);
    expect(view.secrets).toHaveLength(1);
    expect(Object.keys(view.secrets[0]).sort()).toEqual(["fingerprint", "name", "setAt"]);
    expect((await tb.admin("PUT", "/admin/servers/missing/secrets/TOKEN", { value: "x".repeat(10) })).status).toBe(404);
    expect((await tb.admin("PUT", "/admin/servers/wo/secrets/bad name", { value: "x".repeat(10) })).status).toBe(400);
    expect((await tb.admin("DELETE", "/admin/servers/wo/secrets/TOKEN")).status).toBe(204);
    expect((await tb.admin("GET", "/admin/servers/wo")).json().missingSecrets).toEqual(["TOKEN"]);
  });

  it("어떤 관리 응답에도 비밀값(어떤 인코딩이든)이 나오지 않는다", async () => {
    const secrets: string[] = [];
    const servers = ["p1", "p2", "p3"];
    for (const id of servers) {
      const res = await tb.admin(
        "PUT",
        `/admin/servers/${id}`,
        httpServer(id, {
          transport: {
            type: "http",
            url: "http://127.0.0.1:9/mcp",
            headers: { Authorization: "Bearer {{secret:TOKEN}}", "X-Key": "{{secret:KEY}}" },
          },
        }),
      );
      expect(res.status).toBe(201);
      for (const name of ["TOKEN", "KEY"]) {
        const value = `${name.toLowerCase()}-${randomBytes(12).toString("base64url")}`;
        secrets.push(value);
        expect((await tb.admin("PUT", `/admin/servers/${id}/secrets/${name}`, { value })).status).toBe(204);
      }
    }
    // 연결 실패 경로(오류 메시지)도 포함한다: 포트 9에는 아무것도 없다.
    const bodies: string[] = [];
    bodies.push((await tb.admin("GET", "/admin/servers")).text);
    for (const id of servers) {
      bodies.push((await tb.admin("GET", `/admin/servers/${id}`)).text);
      bodies.push((await tb.admin("POST", `/admin/servers/${id}/test`, {})).text);
      bodies.push((await tb.admin("GET", `/admin/servers/${id}/tools?user=alice`)).text);
      bodies.push((await tb.admin("PUT", `/admin/servers/${id}`, httpServer(id, { description: "again" }))).text);
    }
    bodies.push((await tb.admin("GET", "/admin/audit?limit=1000")).text);
    const dataServers = await tb.broker.dataPlane.inject({
      method: "GET",
      url: "/mcp/servers",
      headers: { authorization: `Bearer ${await tb.token({ sub: "alice" })}` },
    });
    bodies.push(dataServers.body);

    const all = bodies.join("\n");
    expect(all.length).toBeGreaterThan(100);
    for (const secret of secrets) for (const variant of secretVariants(secret)) expect(all).not.toContain(variant);
  });

  describe("비밀값 행선지가 바뀌면 저장된 비밀값을 지운다", () => {
    const base = (headers: Record<string, string>, url = "https://api.example.com/mcp") => ({
      runIn: "broker",
      transport: { type: "http", url, headers },
    });

    const setup = async (id: string) => {
      expect((await tb.admin("PUT", `/admin/servers/${id}`, base({ Authorization: "Bearer {{secret:TOKEN}}" }))).status).toBe(201);
      expect((await tb.admin("PUT", `/admin/servers/${id}/secrets/TOKEN`, { value: "keep-or-clear-123" })).status).toBe(204);
    };
    const secretNames = async (id: string) =>
      ((await tb.admin("GET", `/admin/servers/${id}`)).json().secrets as { name: string }[]).map((s) => s.name);

    it("url origin이 바뀌면 지우고 감사 기록을 남긴다", async () => {
      await setup("move-origin");
      const res = await tb.admin("PUT", "/admin/servers/move-origin", base({ Authorization: "Bearer {{secret:TOKEN}}" }, "https://attacker.example/mcp"));
      expect(res.status).toBe(200);
      expect(res.json().missingSecrets).toEqual(["TOKEN"]);
      expect(await secretNames("move-origin")).toEqual([]);
      const events = (await tb.admin("GET", "/admin/audit?limit=5")).json().events as { action: string; serverId?: string; detail?: string }[];
      expect(events[0]).toMatchObject({ action: "secret.invalidate", serverId: "move-origin" });
      expect(events[0]!.detail).toContain("TOKEN");
    });

    it("비밀값을 싣는 헤더가 바뀌면 지운다", async () => {
      await setup("move-header");
      await tb.admin("PUT", "/admin/servers/move-header", base({ "X-Forward-To": "Bearer {{secret:TOKEN}}" }));
      expect(await secretNames("move-header")).toEqual([]);
    });

    it("stdio 명령·인자·env가 바뀌면 지운다", async () => {
      const stdio = (args: string[], env: Record<string, string>) => ({
        runIn: "broker",
        transport: { type: "stdio", command: "node", args, env: { TOKEN: "{{secret:TOKEN}}", ...env } },
      });
      for (const [label, next] of [
        ["args", stdio(["other.js"], {})],
        ["env", stdio(["server.js"], { API_BASE_URL: "https://attacker.example" })],
      ] as const) {
        const id = `stdio-${label}`;
        expect((await tb.admin("PUT", `/admin/servers/${id}`, stdio(["server.js"], {}))).status).toBe(201);
        await tb.admin("PUT", `/admin/servers/${id}/secrets/TOKEN`, { value: "stdio-secret-1234" });
        await tb.admin("PUT", `/admin/servers/${id}`, next);
        expect(await secretNames(id), label).toEqual([]);
      }
    });

    it("이름·설명·timeout·도구 필터·enabled 변경은 비밀값을 그대로 둔다", async () => {
      await setup("cosmetic");
      const res = await tb.admin("PUT", "/admin/servers/cosmetic", {
        ...base({ Authorization: "Bearer {{secret:TOKEN}}" }, "https://api.example.com/other/path?x=1"),
        displayName: "New name",
        description: "desc",
        timeoutSec: 30,
        toolAllow: ["a"],
        enabled: false,
        scope: "per-user",
      });
      expect(res.status).toBe(200);
      expect(res.json().missingSecrets).toEqual([]);
      expect(await secretNames("cosmetic")).toEqual(["TOKEN"]);
    });

    it("행선지를 바꾼 뒤 이름만 바꿔 다시 참조해도 예전 값이 남아 있지 않다", async () => {
      await setup("two-step");
      // 1) 행선지만 바꾸고 다른 이름을 참조 → 기존 값은 이미 지워진다
      await tb.admin("PUT", "/admin/servers/two-step", base({ Authorization: "Bearer {{secret:OTHER}}" }, "https://attacker.example/mcp"));
      // 2) 같은 행선지에서 예전 이름을 다시 참조
      const res = await tb.admin("PUT", "/admin/servers/two-step", base({ Authorization: "Bearer {{secret:TOKEN}}" }, "https://attacker.example/mcp"));
      expect(res.json().missingSecrets).toEqual(["TOKEN"]);
    });
  });

  it("감사 기록에 행위자와 동작을 남긴다", async () => {
    await tb.admin("PUT", "/admin/servers/audited", httpServer("audited"));
    await tb.admin("PUT", "/admin/servers/audited/secrets/TOKEN", { value: "audit-secret-value" });
    const events = (await tb.admin("GET", "/admin/audit?limit=10")).json().events as { actor: string; action: string; serverId?: string }[];
    expect(events[0]).toMatchObject({ actor: "tester", action: "secret.put", serverId: "audited" });
    expect(events[1]).toMatchObject({ action: "server.create", serverId: "audited" });
    expect(JSON.stringify(events)).not.toContain("audit-secret-value");
  });

  it("데이터 평면 목록에는 enabled이고 비밀키가 다 있는 서버만 나온다", async () => {
    await tb.admin("PUT", "/admin/servers/vis-ready", httpServer("vis-ready"));
    await tb.admin("PUT", "/admin/servers/vis-ready/secrets/TOKEN", { value: "ready-secret-1" });
    await tb.admin("PUT", "/admin/servers/vis-missing", httpServer("vis-missing"));
    await tb.admin("PUT", "/admin/servers/vis-off", httpServer("vis-off", { enabled: false }));
    await tb.admin("PUT", "/admin/servers/vis-off/secrets/TOKEN", { value: "off-secret-12" });
    const res = await tb.broker.dataPlane.inject({
      method: "GET",
      url: "/mcp/servers",
      headers: { authorization: `Bearer ${await tb.token({ sub: "bob" })}` },
    });
    const ids = (res.json().servers as { id: string }[]).map((s) => s.id);
    expect(ids).toContain("vis-ready");
    expect(ids).not.toContain("vis-missing");
    expect(ids).not.toContain("vis-off");
    const ready = (res.json().servers as { id: string; timeoutSec: number; displayName?: string }[]).find((s) => s.id === "vis-ready");
    expect(ready).toMatchObject({ timeoutSec: 120, displayName: "Server vis-ready" });
  });
});
