import { AUD_BROKER, AUD_BROKER_ADMIN, AUD_SANDBOXD, signInternalToken } from "@pi-gateway/shared";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type TestBroker } from "./helpers.js";

describe("data plane authentication", () => {
  let tb: TestBroker;
  beforeAll(async () => {
    tb = await startTestBroker();
  });
  afterAll(async () => {
    await tb.close();
  });

  const get = (token?: string) =>
    tb.broker.dataPlane.inject({
      method: "GET",
      url: "/mcp/servers",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("유효한 토큰이면 서버 목록을 준다", async () => {
    const res = await get(await tb.token({ sub: "alice" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: [] });
  });

  it("토큰이 없으면 401", async () => {
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("다른 audience(sandboxd용·관리 평면용) 토큰은 거부한다", async () => {
    for (const audience of [AUD_SANDBOXD, AUD_BROKER_ADMIN]) {
      const token = await signInternalToken(tb.config.jwtSecret, audience, { sub: "alice" });
      expect((await get(token)).statusCode, audience).toBe(401);
    }
  });

  it("다른 비밀키로 서명한 토큰은 거부한다", async () => {
    const token = await signInternalToken(new TextEncoder().encode("z".repeat(40)), AUD_BROKER, { sub: "alice" });
    expect((await get(token)).statusCode).toBe(401);
  });

  it("만료된 토큰은 거부한다", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pi-gateway:gateway")
      .setAudience(AUD_BROKER)
      .setSubject("alice")
      .setIssuedAt(now - 100)
      .setExpirationTime(now - 50)
      .sign(tb.config.jwtSecret);
    expect((await get(token)).statusCode).toBe(401);
  });

  it("관리용 _admin subject는 데이터 평면에서 거부한다", async () => {
    expect((await get(await tb.token({ sub: "_admin", sid: "catalog" }))).statusCode).toBe(401);
  });

  it("principal 형식이 아닌 subject는 거부한다", async () => {
    const token = await tb.token({ sub: "../../etc" });
    expect((await get(token)).statusCode).toBe(401);
  });

  it("alg none 토큰은 거부한다", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: "pi-gateway:gateway", aud: AUD_BROKER, sub: "alice", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString("base64url");
    expect((await get(`${header}.${payload}.`)).statusCode).toBe(401);
  });

  it("관리 평면은 토큰이 없거나 데이터 평면용 토큰이면 401", async () => {
    const none = await tb.broker.adminPlane.inject({ method: "GET", url: "/admin/servers" });
    expect(none.statusCode).toBe(401);
    const jwt = await tb.token({ sub: "alice" });
    const wrong = await tb.broker.adminPlane.inject({
      method: "GET",
      url: "/admin/servers",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("라우터가 같은 경로로 풀어 주는 다른 표기로도 토큰 없이는 닿지 못한다", async () => {
    // 인증을 URL 글자로 고르면 %-인코딩한 경로가 검사를 건너뛴다. healthz가 아닌 모든 경로가 토큰을 요구해야 한다.
    for (const url of ["/%6dcp/servers", "/%6Dcp/servers", "/%6dcp/echo", "/nope"]) {
      expect((await tb.broker.dataPlane.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    for (const url of ["/%61dmin/servers", "/%41dmin/servers", "/%61dmin/servers/x", "/nope"]) {
      expect((await tb.broker.adminPlane.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    const put = await tb.broker.adminPlane.inject({
      method: "PUT",
      url: "/%61dmin/servers/evil",
      payload: { runIn: "broker", transport: { type: "http", url: "http://example.invalid/mcp", headers: {} } },
    });
    expect(put.statusCode).toBe(401);
    expect((await tb.admin("GET", "/admin/servers")).json().servers).toEqual([]);
  });

  it("healthz는 인증 없이 열린다", async () => {
    expect((await tb.broker.dataPlane.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
