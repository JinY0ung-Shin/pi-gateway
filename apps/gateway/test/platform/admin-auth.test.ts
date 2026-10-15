import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { AdminAuth } from "../../src/admin/auth.js";
import { parseCidr } from "../../src/config.js";
import { openDatabase } from "../../src/db.js";
import { ADMIN_KEY, adminHeaders, buildHarness, cleanupTempDirs, type Harness, makeConfig, tempDir } from "./helpers.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
  delete process.env.ADMIN_UI_DIR;
});

describe("admin auth", () => {
  it("ADMIN_API_KEY가 없으면 관리 API 전체가 403이다", async () => {
    h = await buildHarness({ env: { ADMIN_API_KEY: undefined } });
    for (const [method, url] of [
      ["GET", "/admin/api/prompts"],
      ["POST", "/admin/api/login"],
      ["GET", "/admin/api/session"],
    ] as const) {
      const res = await h.app.inject({ method, url, headers: { ...adminHeaders, "x-admin-request": "1" } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("admin_disabled");
    }
  });

  it("인증이 없으면 401, Bearer가 맞으면 통과, 틀리면 401", async () => {
    h = await buildHarness();
    expect((await h.app.inject({ method: "GET", url: "/admin/api/prompts" })).statusCode).toBe(401);
    expect((await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: adminHeaders })).statusCode).toBe(200);
    const wrong = await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    // Bearer는 브라우저가 자동으로 붙이지 않으므로 CSRF 헤더 없이도 변경할 수 있다
    const create = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts",
      headers: { ...adminHeaders, "content-type": "application/json" },
      payload: { name: "p", content: "x" },
    });
    expect(create.statusCode).toBe(201);
  });

  it("로그인 쿠키: HttpOnly·SameSite=Strict, 변경 요청은 X-Admin-Request 필요, 로그아웃하면 무효", async () => {
    h = await buildHarness();
    const noHeader = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(noHeader.statusCode).toBe(403);
    const bad = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/admin/);
    expect(setCookie).not.toContain(ADMIN_KEY);
    const cookie = setCookie.split(";")[0]!;

    const session = await h.app.inject({ method: "GET", url: "/admin/api/session", headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, via: "cookie" });

    const csrf = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts",
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "p", content: "x" },
    });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe("csrf");
    const ok = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts",
      headers: { cookie, "x-admin-request": "1", "content-type": "application/json" },
      payload: { name: "p", content: "x" },
    });
    expect(ok.statusCode).toBe(201);

    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await h.app.inject({ method: "GET", url: "/admin/api/session", headers: { cookie: tampered } })).statusCode).toBe(401);

    await h.app.inject({ method: "POST", url: "/admin/api/logout", headers: { cookie, "x-admin-request": "1" } });
    expect((await h.app.inject({ method: "GET", url: "/admin/api/session", headers: { cookie } })).statusCode).toBe(401);
  });

  it("로그인 실패가 반복되면 429", async () => {
    h = await buildHarness();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/admin/api/login",
        headers: { "x-admin-request": "1", "content-type": "application/json" },
        payload: { apiKey: `wrong-${i}` },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  it("관리 API 응답에는 보안 헤더와 no-store가 붙는다", async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: "GET", url: "/admin/api/status", headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.json()).toMatchObject({ stats: { liveSessions: 2 }, sandboxes: { items: [{ key: "u-abc" }] } });
    const missing = await h.app.inject({ method: "GET", url: "/admin/api/nope", headers: adminHeaders });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });
});

describe("admin auth hardening", () => {
  const status = (headers: Record<string, string>, remoteAddress?: string) =>
    h.app.inject({ method: "GET", url: "/admin/api/status", headers, ...(remoteAddress ? { remoteAddress } : {}) });

  it("Bearer 실패도 센다: 5번은 그냥 실패, 6번째부터 잠금(429·Retry-After), 잠긴 동안은 맞는 키·로그인도 429, 다른 주소는 영향 없음", async () => {
    h = await buildHarness();
    for (let i = 0; i < 6; i++) expect((await status({ authorization: `Bearer wrong-${i}` })).statusCode).toBe(401);
    const locked = await status(adminHeaders);
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    const login = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(login.statusCode).toBe(429);
    expect((await status(adminHeaders, "10.9.9.9")).statusCode).toBe(200);
  });

  it("잠금 시간은 실패할 때마다 두 배로 늘고 상한이 있으며, 오래 실패가 없으면 잊는다", () => {
    let now = 1_000_000;
    const config = makeConfig({ dataDir: tempDir("auth-data"), pluginsDir: tempDir("auth-plugins") });
    const auth = new AdminAuth(openDatabase(":memory:"), config, {
      freeAttempts: 2,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      forgetAfterMs: 60_000,
      now: () => now,
    });
    const req = { ip: "1.2.3.4", headers: { authorization: "Bearer bad" } } as unknown as FastifyRequest;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      expect(auth.authenticate(req)).toBeNull(); // 잠기지 않은 상태에서 실패
      delays.push(auth.retryAfterSeconds("1.2.3.4"));
      if (delays.at(-1)! > 0) expect(() => auth.authenticate(req)).toThrow(expect.objectContaining({ status: 429 }));
      now += 10_000; // 잠금이 풀린 뒤 다시 시도
    }
    // 무료 2번 뒤 1·2·4·8초, 그리고 상한 8초
    expect(delays).toEqual([0, 0, 1, 2, 4, 8, 8]);
    now += 120_000; // 오래 지나면 잊는다
    expect(auth.authenticate(req)).toBeNull();
    expect(auth.retryAfterSeconds("1.2.3.4")).toBe(0);
  });

  it("실패 기록은 주소 수 상한을 넘으면 가장 오래된 것부터 지운다", () => {
    const config = makeConfig({ dataDir: tempDir("auth-data"), pluginsDir: tempDir("auth-plugins") });
    const auth = new AdminAuth(openDatabase(":memory:"), config, { maxTrackedAddresses: 3, freeAttempts: 1 });
    const req = (ip: string) => ({ ip, headers: { authorization: "Bearer bad" } }) as unknown as FastifyRequest;
    auth.authenticate(req("1.1.1.1"));
    auth.authenticate(req("1.1.1.1"));
    expect(() => auth.authenticate(req("1.1.1.1"))).toThrow(expect.objectContaining({ status: 429 }));
    for (const ip of ["2.2.2.2", "3.3.3.3", "4.4.4.4"]) auth.authenticate(req(ip));
    expect(auth.trackedAddresses).toBe(3);
    // 가장 오래된 1.1.1.1이 밀려나 잠금도 풀렸다
    expect(auth.authenticate(req("1.1.1.1"))).toBeNull();
  });

  it("ADMIN_ALLOWED_CIDRS 밖의 주소는 관리 API와 UI 모두 403", async () => {
    h = await buildHarness({ env: { ADMIN_ALLOWED_CIDRS: "10.0.0.0/8, fd00::/8" } });
    expect((await status(adminHeaders, "10.1.2.3")).statusCode).toBe(200);
    expect((await status(adminHeaders, "::ffff:10.1.2.3")).statusCode).toBe(200);
    expect((await status(adminHeaders, "fd12::5")).statusCode).toBe(200);
    const denied = await status(adminHeaders, "192.168.0.10");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("address_not_allowed");
    expect((await status(adminHeaders)).statusCode).toBe(403); // inject 기본 주소 127.0.0.1
    const ui = await h.app.inject({ method: "GET", url: "/admin/", remoteAddress: "192.168.0.10" });
    expect(ui.statusCode).toBe(403);
    expect(ui.body).toBe("Forbidden");
    const login = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      remoteAddress: "192.168.0.10",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(login.statusCode).toBe(403);
  });

  it("설정: TRUST_PROXY·ADMIN_ALLOWED_CIDRS 값을 검사한다", () => {
    const dirs = { dataDir: tempDir("cfg-data"), pluginsDir: tempDir("cfg-plugins") };
    const cfg = (env: Record<string, string>) => makeConfig({ ...dirs, env });
    expect(cfg({}).trustProxy).toBe(false);
    expect(cfg({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(() => cfg({ TRUST_PROXY: "2" })).toThrow(/hop counts are not supported/);
    expect(cfg({ TRUST_PROXY: "0" }).trustProxy).toBe(false);
    // X-Forwarded-For를 무조건 믿으면 CIDR 제한·로그인 지연을 우회할 수 있으므로 함께 쓸 수 없다
    expect(() => cfg({ TRUST_PROXY: "true", ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" })).toThrow(/cannot be combined/);
    expect(cfg({ TRUST_PROXY: "172.18.0.1", ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" }).trustProxy).toEqual(["172.18.0.1"]);
    expect(cfg({ TRUST_PROXY: "10.0.0.1, 172.16.0.0/12" }).trustProxy).toEqual(["10.0.0.1", "172.16.0.0/12"]);
    expect(() => cfg({ TRUST_PROXY: "proxy.local" })).toThrow(/TRUST_PROXY/);
    expect(cfg({ ADMIN_ALLOWED_CIDRS: "10.0.0.0/8,::1" }).admin.allowedCidrs).toEqual(["10.0.0.0/8", "::1"]);
    expect(() => cfg({ ADMIN_ALLOWED_CIDRS: "10.0.0.0/33" })).toThrow(/ADMIN_ALLOWED_CIDRS/);
    expect(parseCidr("fd00::/8")).toEqual({ address: "fd00::", prefix: 8, family: "ipv6" });
    expect(parseCidr("10.0.0.0/8/1")).toBeNull();
  });
});

describe("admin UI serving", () => {
  it("빌드된 index.html·assets를 CSP와 함께 서빙하고 SPA 경로는 index.html로 보낸다", async () => {
    const ui = tempDir("ui");
    mkdirSync(join(ui, "assets"));
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>admin</title>");
    writeFileSync(join(ui, "assets", "app.js"), "console.log(1)");
    process.env.ADMIN_UI_DIR = ui;
    h = await buildHarness();
    const index = await h.app.inject({ method: "GET", url: "/admin/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(index.body).toContain("<title>admin</title>");
    expect((await h.app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(200);
    const asset = await h.app.inject({ method: "GET", url: "/admin/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("console.log(1)");
    const spa = await h.app.inject({ method: "GET", url: "/admin/prompts", headers: { accept: "text/html" } });
    expect(spa.body).toContain("<title>admin</title>");
    expect((await h.app.inject({ method: "GET", url: "/admin/missing.js" })).statusCode).toBe(404);
  });

  it("UI가 빌드되지 않았으면 503 안내 페이지", async () => {
    process.env.ADMIN_UI_DIR = tempDir("ui-empty");
    h = await buildHarness();
    const res = await h.app.inject({ method: "GET", url: "/admin/" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("빌드되지 않았습니다");
  });
});

afterAll(cleanupTempDirs);
