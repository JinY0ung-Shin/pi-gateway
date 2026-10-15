import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDACTED, secretVariants } from "../src/redact.js";
import { processesOwnedBy } from "../src/upstream/uid-reaper.js";
import { startHttpFixture, type HttpFixture } from "./fixtures/http-server.js";
import { piClient, processAlive, startTestBroker, type TestBroker, textOf } from "./helpers.js";

const LEAK = "leak-ghp_9f8e7d6c5b4a3210-top-secret";
const CANARY = "broker-process-canary-value-should-never-reach-children";

// 전체 병렬 실행에서는 프로세스 생성이 느려질 수 있어 시간 제한을 넉넉히 둔다.
const HOOK_TIMEOUT = 120_000;

describe("data plane (pi-mcp client ↔ broker ↔ upstream fixtures)", { timeout: 120_000 }, () => {
  let tb: TestBroker;
  let http: HttpFixture;

  beforeAll(async () => {
    process.env.PI_BROKER_TEST_CANARY = CANARY;
    tb = await startTestBroker();
    http = await startHttpFixture();

    await tb.addStdioServer("echo", {
      transport: { env: { LEAK_VALUE: "{{secret:LEAK}}", FIXED: "fixed-value" } },
      toolDeny: ["hidden"],
      timeoutSec: 30,
    });
    expect((await tb.admin("PUT", "/admin/servers/echo/secrets/LEAK", { value: LEAK })).status).toBe(204);

    await tb.addStdioServer("peruser", { scope: "per-user", transport: { env: { USER_ID: "{{user}}" } } });
    await tb.addStdioServer("persession", {
      scope: "per-session",
      transport: { env: { USER_ID: "{{user}}", THREAD_ID: "{{metadata:thread_id}}" } },
    });
    await tb.addStdioServer("quick", { timeoutSec: 1 });
    await tb.addStdioServer("allowonly", { toolAllow: ["whoami"] });

    const putHttp = await tb.admin("PUT", "/admin/servers/remote", {
      runIn: "broker",
      transport: {
        type: "http",
        url: http.url,
        headers: { Authorization: "Bearer {{secret:TOKEN}}", "X-User": "{{user}}", "X-Forwarded-Token": "{{ctx.header:x-user-token}}" },
      },
    });
    expect(putHttp.status).toBe(201);
    expect((await tb.admin("PUT", "/admin/servers/remote/secrets/TOKEN", { value: "remote-bearer-token-42" })).status).toBe(204);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    delete process.env.PI_BROKER_TEST_CANARY;
    await tb?.close();
    await http?.close();
  }, HOOK_TIMEOUT);

  it("pi-mcp McpClient로 연결해 도구를 나열하고 호출한다 (toolDeny 적용)", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    expect(client.protocolVersion).toBe("2025-11-25");
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).not.toContain("hidden");
    const result = await client.callTool("whoami", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).pid).toBeGreaterThan(0);
    const denied = await client.callTool("hidden", {});
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).not.toContain("you should not see this");
    await client.close();
  });

  it("toolAllow면 목록에 있는 도구만 보인다", async () => {
    const client = await piClient(tb, "allowonly", { sub: "alice", sid: "s1" });
    expect((await client.listTools()).map((t) => t.name)).toEqual(["whoami"]);
    expect((await client.callTool("echo_env", {})).isError).toBe(true);
    await client.close();
  });

  it("stdio 자식의 env에는 설정한 값과 최소 기본값만 있다 (broker env를 물려주지 않는다)", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    const env = JSON.parse(textOf(await client.callTool("echo_env", {}))) as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(["FIXED", "HOME", "LANG", "LEAK_VALUE", "PATH", "TMPDIR"]);
    expect(env.FIXED).toBe("fixed-value");
    expect(JSON.stringify(env)).not.toContain(CANARY);
    await client.close();
  });

  it("도구 결과·구조화 결과·키에 들어간 비밀값을 모든 인코딩에서 가린다", async () => {
    const client = await piClient(tb, "echo", { sub: "alice", sid: "s1" });
    const envResult = JSON.stringify(await client.callTool("echo_env", {}));
    const leakResult = JSON.stringify(await client.callTool("leak", {}));
    for (const out of [envResult, leakResult]) {
      expect(out).toContain(REDACTED);
      for (const variant of secretVariants(LEAK)) expect(out).not.toContain(variant);
    }
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

  it("per-user 서버는 사용자마다 다른 프로세스를 쓰고, 같은 사용자는 다시 쓴다", async () => {
    const alice = await piClient(tb, "peruser", { sub: "alice", sid: "a1" });
    const bob = await piClient(tb, "peruser", { sub: "bob", sid: "b1" });
    const a1 = JSON.parse(textOf(await alice.callTool("whoami", {})));
    const b1 = JSON.parse(textOf(await bob.callTool("whoami", {})));
    const a2 = JSON.parse(textOf(await alice.callTool("whoami", {})));
    expect(a1.userId).toBe("alice");
    expect(b1.userId).toBe("bob");
    expect(a1.pid).not.toBe(b1.pid);
    expect(a2.pid).toBe(a1.pid);
    // 다른 세션이어도 같은 사용자면 같은 프로세스
    const alice2 = await piClient(tb, "peruser", { sub: "alice", sid: "a2" });
    expect(JSON.parse(textOf(await alice2.callTool("whoami", {}))).pid).toBe(a1.pid);
    await Promise.all([alice.close(), bob.close(), alice2.close()]);
  });

  it("shared 서버는 사용자 간에 프로세스를 공유한다 (사용자별 값이 없을 때만)", async () => {
    const alice = await piClient(tb, "echo", { sub: "alice", sid: "a1" });
    const bob = await piClient(tb, "echo", { sub: "bob", sid: "b1" });
    const a = JSON.parse(textOf(await alice.callTool("whoami", {})));
    const b = JSON.parse(textOf(await bob.callTool("whoami", {})));
    expect(a.pid).toBe(b.pid);
    await Promise.all([alice.close(), bob.close()]);
  });

  it("per-session 서버는 세션마다 프로세스가 다르고 metadata가 env로 들어간다", async () => {
    const s1 = await piClient(tb, "persession", { sub: "alice", sid: "x1", ctx: { metadata: { thread_id: "thread-1" } } });
    const s2 = await piClient(tb, "persession", { sub: "alice", sid: "x2", ctx: { metadata: { thread_id: "thread-2" } } });
    const r1 = JSON.parse(textOf(await s1.callTool("whoami", {})));
    const r2 = JSON.parse(textOf(await s2.callTool("whoami", {})));
    expect(r1.threadId).toBe("thread-1");
    expect(r2.threadId).toBe("thread-2");
    expect(r1.pid).not.toBe(r2.pid);
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

  it("연결을 정리하면 손자 프로세스까지 process group째 종료한다", async () => {
    const client = await piClient(tb, "peruser", { sub: "grandparent-test", sid: "g1" });
    const { pid: grandchild } = JSON.parse(textOf(await client.callTool("spawn_grandchild", {}))) as { pid: number };
    const { pid: server } = JSON.parse(textOf(await client.callTool("whoami", {}))) as { pid: number };
    expect(processAlive(grandchild)).toBe(true);
    await client.close();
    tb.broker.pool.retireServer("peruser");
    for (let i = 0; i < 300 && (processAlive(grandchild) || processAlive(server)); i++) await new Promise((r) => setTimeout(r, 100));
    expect(processAlive(server)).toBe(false);
    expect(processAlive(grandchild)).toBe(false);
  });

  it("setsid로 process group을 빠져나간 자손은 group kill로는 남는다 — uid 정리가 필요한 이유", async () => {
    const client = await piClient(tb, "peruser", { sub: "escape-test", sid: "e1" });
    const { pid: escaped } = JSON.parse(textOf(await client.callTool("escape_group", {}))) as { pid: number };
    try {
      await client.close();
      tb.broker.pool.retireServer("peruser");
      await new Promise((r) => setTimeout(r, 500));
      // 세션이 다르므로 process group kill이 닿지 않는다.
      expect(processAlive(escaped)).toBe(true);
      // 하지만 uid 기준 /proc 검색에는 잡힌다. uid 범위를 쓰면 reapUid가 이 프로세스까지 죽인다.
      expect(await processesOwnedBy(process.getuid!())).toContain(escaped);
    } finally {
      try {
        process.kill(escaped, "SIGKILL");
      } catch {
        // 이미 끝났다
      }
    }
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

  it("비밀키를 바꾸면 새 프로세스가 새 값으로 뜬다", async () => {
    const client = await piClient(tb, "echo", { sub: "dave", sid: "d1" });
    const before = JSON.parse(textOf(await client.callTool("whoami", {})));
    expect((await tb.admin("PUT", "/admin/servers/echo/secrets/LEAK", { value: `${LEAK}-rotated` })).status).toBe(204);
    const after = JSON.parse(textOf(await client.callTool("whoami", {})));
    expect(after.pid).not.toBe(before.pid);
    const leak = JSON.stringify(await client.callTool("leak", {}));
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
