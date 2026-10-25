import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED, secretVariants } from "../src/redact.js";
import { startHttpFixture, type HttpFixture } from "./fixtures/http-server.js";
import { piClient, startTestBroker, type TestBroker, textOf } from "./helpers.js";

const LEAK = "leak-ghp_9f8e7d6c5b4a3210-top-secret";

describe("data plane (pi-mcp client ↔ broker ↔ upstream fixture)", { timeout: 120_000 }, () => {
  let tb: TestBroker;
  let http: HttpFixture;

  beforeAll(async () => {
    tb = await startTestBroker();
    http = await startHttpFixture();

    await tb.addHttpServer("echo", http.url, { headers: { "X-Leak": "{{secret:LEAK}}" }, toolDeny: ["hidden"], timeoutSec: 30 });
    expect((await tb.admin("PUT", "/admin/servers/echo/secrets/LEAK", { value: LEAK })).status).toBe(204);

    await tb.addHttpServer("shared", http.url);
    await tb.addHttpServer("peruser", http.url, { scope: "per-user", headers: { "X-User": "{{user}}" } });
    await tb.addHttpServer("persession", http.url, { scope: "per-session", headers: { "X-User": "{{user}}", "X-Thread": "{{metadata:thread_id}}" } });
    await tb.addHttpServer("quick", http.url, { timeoutSec: 1 });
    await tb.addHttpServer("allowonly", http.url, { toolAllow: ["whoami"] });
    await tb.addHttpServer("remote", http.url, {
      headers: { Authorization: "Bearer {{secret:TOKEN}}", "X-User": "{{user}}", "X-Forwarded-Token": "{{ctx.header:x-user-token}}" },
      toolAllow: ["headers", "echo_auth"],
    });
    expect((await tb.admin("PUT", "/admin/servers/remote/secrets/TOKEN", { value: "remote-bearer-token-42" })).status).toBe(204);
  });

  afterAll(async () => {
    await tb?.close();
    await http?.close();
  });

  it("pi-mcp McpClient로 연결해 도구를 나열하고 호출한다 (toolDeny 적용)", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    expect(client.protocolVersion).toBe("2025-11-25");
    const names = (await client.listTools()).map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).not.toContain("hidden");
    expect((await client.callTool("whoami", {})).isError).toBeFalsy();
    const denied = await client.callTool("hidden", {});
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).not.toContain("you should not see this");
    await client.close();
  });

  it("toolAllow면 목록에 있는 도구만 보인다", async () => {
    const client = await piClient(tb, "allowonly", { sub: "alice", sid: "s1" });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["whoami"]);
    expect((await client.callTool("headers", {})).isError).toBe(true);
    await client.close();
  });

  it("도구 결과·구조화 결과·키에 들어간 비밀값을 모든 인코딩에서 가린다", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    const out = JSON.stringify(await client.callTool("leak", {}));
    expect(out).toContain(REDACTED);
    for (const variant of secretVariants(LEAK)) expect(out).not.toContain(variant);
    await client.close();
  });

  it("upstream 오류는 상관 id가 붙은 일반 메시지가 되고 비밀값이 새지 않는다", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    const failed = await client.callTool("fail", {});
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/^Upstream MCP server error \(ref [0-9a-f]{8}\)$/);

    const toolError = await client.callTool("tool_error", {});
    expect(toolError.isError).toBe(true);
    expect(textOf(toolError)).toContain(REDACTED);
    expect(textOf(toolError)).not.toContain(LEAK);

    const badArgs = await client.callTool("bad_args", {});
    expect(textOf(badArgs)).toMatch(/rejected the call: missing required argument 'repo'/);
    expect(textOf(badArgs)).not.toContain(LEAK);
    await client.close();
  });

  it("per-user 서버는 사용자마다 다른 연결을 쓰고, 같은 사용자는 다시 쓴다", async () => {
    const alice = await piClient(tb, "peruser", { sub: "alice", sid: "a1" });
    const bob = await piClient(tb, "peruser", { sub: "bob", sid: "b1" });
    expect(JSON.parse(textOf(await alice.callTool("whoami", {}))).user).toBe("alice");
    expect(JSON.parse(textOf(await bob.callTool("whoami", {}))).user).toBe("bob");
    expect(tb.broker.pool.count("peruser")).toBe(2);
    // 다른 세션이어도 같은 사용자면 같은 연결
    const alice2 = await piClient(tb, "peruser", { sub: "alice", sid: "a2" });
    expect(JSON.parse(textOf(await alice2.callTool("whoami", {}))).user).toBe("alice");
    expect(tb.broker.pool.count("peruser")).toBe(2);
    await Promise.all([alice.close(), bob.close(), alice2.close()]);
  });

  it("shared 서버는 사용자 간에 연결을 공유한다 (사용자별 값이 없을 때만)", async () => {
    const alice = await piClient(tb, "shared", { sub: "alice", sid: "a1" });
    const bob = await piClient(tb, "shared", { sub: "bob", sid: "b1" });
    await alice.callTool("whoami", {});
    await bob.callTool("whoami", {});
    expect(tb.broker.pool.count("shared")).toBe(1);
    await Promise.all([alice.close(), bob.close()]);
  });

  it("per-session 서버는 세션마다 연결이 다르고 metadata가 헤더로 들어간다", async () => {
    const s1 = await piClient(tb, "persession", { sub: "alice", sid: "x1", ctx: { metadata: { thread_id: "thread-1" } } });
    const s2 = await piClient(tb, "persession", { sub: "alice", sid: "x2", ctx: { metadata: { thread_id: "thread-2" } } });
    expect(JSON.parse(textOf(await s1.callTool("whoami", {}))).thread).toBe("thread-1");
    expect(JSON.parse(textOf(await s2.callTool("whoami", {}))).thread).toBe("thread-2");
    expect(tb.broker.pool.count("persession")).toBe(2);
    await Promise.all([s1.close(), s2.close()]);
  });

  it("http upstream에 비밀키·사용자·전달 헤더를 주입하고, 되돌아온 토큰은 가린다", async () => {
    const client = await piClient(tb, "remote", {
      sub: "carol",
      sid: "c1",
      ctx: { headers: { "x-user-token": "carol-user-token-777" } },
    });
    const seen = JSON.parse(textOf(await client.callTool("headers", {}))) as Record<string, string>;
    expect(seen.authorization).toBe(`Bearer ${REDACTED}`);
    expect(seen.xUser).toBe("carol");
    expect(seen.xToken).toBe(REDACTED);
    const lastCall = http.requests.filter((r) => r.method === "POST").at(-1)!;
    expect(lastCall.headers.authorization).toBe("Bearer remote-bearer-token-42");
    expect(lastCall.headers["x-forwarded-token"]).toBe("carol-user-token-777");
    // gateway가 보낸 내부 JWT는 upstream으로 넘어가지 않는다
    expect(JSON.stringify(http.requests.map((r) => r.headers))).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    const echoed = await client.callTool("echo_auth", {});
    expect(textOf(echoed)).toBe(`auth=Bearer ${REDACTED}`);
    await client.close();
  });

  it("서버별 timeout을 넘기면 끊고 알려준다", async () => {
    const client = await piClient(tb, "quick", { sub: "alice", sid: "s1" });
    const started = Date.now();
    const result = await client.callTool("slow", { ms: 60_000 });
    // 부하가 커도 서버 timeout(1초)에 끊겨야 한다. 60초짜리 도구를 끝까지 기다리지 않는다.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/timed out after 1s/);
    await client.close();
  });

  it("진행 알림을 전달하고 그 안의 비밀값도 가린다", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    const progress: unknown[] = [];
    const result = await client.callTool("slow", { ms: 300, steps: 3 }, { onProgress: (p) => progress.push(p) });
    expect(textOf(result)).toBe("done");
    expect(progress.length).toBe(3);
    expect(JSON.stringify(progress)).not.toContain(LEAK);
    await client.close();
  });

  it("없거나 꺼진 서버는 404", async () => {
    const token = await tb.token({ sub: "alice", sid: "s1" });
    const res = await tb.broker.dataPlane.inject({
      method: "POST",
      url: "/mcp/nope",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("비밀키를 바꾸면 새 연결이 새 값으로 붙는다", async () => {
    const client = await piClient(tb, "echo", { sub: "dave", sid: "d1" });
    await client.callTool("whoami", {});
    expect((await tb.admin("PUT", "/admin/servers/echo/secrets/LEAK", { value: `${LEAK}-rotated` })).status).toBe(204);
    const leak = JSON.stringify(await client.callTool("leak", {}));
    expect(http.requests.filter((r) => r.method === "POST").at(-1)!.headers["x-leak"]).toBe(`${LEAK}-rotated`);
    expect(leak).not.toContain("rotated");
    await client.close();
  });

  it("관리 test는 실제 연결로 도구 목록을 확인한다", async () => {
    const res = await tb.admin("POST", "/admin/servers/allowonly/test", { user: "alice" });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, tools: [{ name: "whoami" }] });
    const tools = await tb.admin("GET", "/admin/servers/remote/tools?user=alice");
    expect(tools.json().tools.map((t: { name: string }) => t.name).sort()).toEqual(["echo_auth", "headers"]);
  });
});
