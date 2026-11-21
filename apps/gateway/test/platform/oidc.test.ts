import { createHmac, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminAuth } from "../../src/admin/auth.js";
import { looksLikeJwt, OidcVerifier } from "../../src/auth/oidc.js";
import { loadConfig } from "../../src/config.js";
import { openDatabase } from "../../src/db.js";
import { ADMIN_KEY, adminHeaders, buildHarness, type Harness, makeConfig, tempDir } from "./helpers.js";

// 발급처(OIDC)의 access token 검증과, 그 토큰으로 관리 API에 들어오는 길.
// 발급처는 이 파일이 띄우는 작은 HTTP 서버(JWKS만 내놓는다)와 여기서 만든 RSA 키다.

const ISSUER = "https://noah.example/sso/realms/noah";
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeSigner(kid: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface Claims {
  typ?: unknown;
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  realm_access?: unknown;
  groups?: unknown;
}

const adminClaims = (): Claims => ({
  typ: "Bearer",
  iss: ISSUER,
  aud: ["pi", "account"],
  sub: "11111111-2222-4333-8444-555555555555",
  exp: nowSeconds() + 300,
  realm_access: { roles: ["admin", "offline_access"] },
  groups: ["teammates"],
});

function sign(signer: Signer, claims: Claims, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: "RS256", typ: "JWT", kid: signer.kid, ...header });
  const body = b64(claims);
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(signer.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

/** JWKS를 내놓는 발급처 흉내. `keys`를 바꾸면 다음 요청부터 그 키가 나간다. */
class FakeIssuer {
  keys: Record<string, unknown>[] = [];
  fetches = 0;
  down = false;
  #server!: Server;
  url = "";
  async start(): Promise<void> {
    this.#server = createServer((_req, res) => {
      this.fetches += 1;
      if (this.down) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: this.keys }));
    });
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/certs`;
  }
  async stop(): Promise<void> {
    await new Promise((resolve) => this.#server.close(resolve));
  }
}

const issuer = new FakeIssuer();
const signer = makeSigner("key-1");
beforeAll(async () => {
  await issuer.start();
});
afterAll(async () => {
  await issuer.stop();
});
afterEach(() => {
  issuer.keys = [signer.jwk];
  issuer.fetches = 0;
  issuer.down = false;
});
issuer.keys = [signer.jwk];

describe("OidcVerifier", () => {
  const verifier = (now: () => number = Date.now) => new OidcVerifier({ issuer: ISSUER, jwksUrl: issuer.url }, fetch, now);

  it("서명·발급처·대상·만료가 맞는 토큰에서 사용자 id, 관리자 여부, 팀원 여부를 꺼낸다", async () => {
    expect(await verifier().verify(sign(signer, adminClaims()))).toEqual({
      user: "11111111-2222-4333-8444-555555555555",
      admin: true,
      teammate: true,
    });
    // 역할·그룹이 없으면 누구인지만 안다
    expect(await verifier().verify(sign(signer, { ...adminClaims(), realm_access: undefined, groups: undefined }))).toEqual({
      user: "11111111-2222-4333-8444-555555555555",
      admin: false,
      teammate: false,
    });
    // aud가 문자열 하나여도 된다
    expect(await verifier().verify(sign(signer, { ...adminClaims(), aud: "pi" }))).not.toBeNull();
  });

  it("클레임이 하나라도 어긋나면 null이다", async () => {
    const v = verifier();
    const cases: [string, Claims][] = [
      ["다른 발급처", { ...adminClaims(), iss: "https://evil.example/realms/noah" }],
      ["pi용이 아닌 토큰 (다른 클라이언트용)", { ...adminClaims(), aud: ["noah", "account"] }],
      ["ID token (aud가 pi여도)", { ...adminClaims(), typ: "ID" }],
      ["typ 없음", { ...adminClaims(), typ: undefined }],
      ["aud 없음", { ...adminClaims(), aud: undefined }],
      ["만료", { ...adminClaims(), exp: nowSeconds() - 31 }],
      ["exp 없음", { ...adminClaims(), exp: undefined }],
      ["아직 유효하지 않음", { ...adminClaims(), nbf: nowSeconds() + 120 }],
      ["sub 없음", { ...adminClaims(), sub: "" }],
    ];
    for (const [label, claims] of cases) expect(await v.verify(sign(signer, claims)), label).toBeNull();
    // 시계 오차 30초 안의 만료는 받는다
    expect(await v.verify(sign(signer, { ...adminClaims(), exp: nowSeconds() - 10 }))).not.toBeNull();
  });

  it("RS256이 아닌 토큰, 서명이 다른 토큰, 내용이 바뀐 토큰은 null이다", async () => {
    const v = verifier();
    const good = sign(signer, adminClaims());
    const [head, body, signature] = good.split(".") as [string, string, string];

    // alg: none
    expect(await v.verify(`${b64({ alg: "none", kid: signer.kid })}.${body}.`)).toBeNull();
    expect(await v.verify(`${b64({ alg: "none", kid: signer.kid })}.${body}.${signature}`)).toBeNull();
    // HS256으로 바꾸고 공개키를 비밀키처럼 써서 서명 (알고리즘 혼동)
    const hsHead = b64({ alg: "HS256", typ: "JWT", kid: signer.kid });
    const publicPem = JSON.stringify(signer.jwk);
    const hsSignature = createHmac("sha256", publicPem).update(`${hsHead}.${body}`).digest("base64url");
    expect(await v.verify(`${hsHead}.${body}.${hsSignature}`)).toBeNull();
    // 다른 키로 서명했지만 kid는 아는 것
    const other = makeSigner(signer.kid);
    expect(await v.verify(sign(other, adminClaims()))).toBeNull();
    // 서명은 그대로 두고 내용만 관리자로 바꿈
    const forged = b64({ ...adminClaims(), sub: "someone-else" });
    expect(await v.verify(`${head}.${forged}.${signature}`)).toBeNull();
    // JWT 모양이 아닌 것
    for (const junk of ["", "abc", "a.b", "a.b.c.d", `${head}.${body}.${signature}=`, `${head}.{}.${signature}`]) {
      expect(await v.verify(junk), junk).toBeNull();
    }
    expect(looksLikeJwt(good)).toBe(true);
    expect(looksLikeJwt(ADMIN_KEY)).toBe(false);
  });

  it("키는 한 번 받아 두고 쓰며, 모르는 kid로는 간격 안에 발급처를 다시 두드리지 않는다", async () => {
    let now = Date.now();
    const v = verifier(() => now);
    for (let i = 0; i < 5; i++) expect(await v.verify(sign(signer, adminClaims()))).not.toBeNull();
    expect(issuer.fetches).toBe(1);

    const stranger = makeSigner("key-unknown");
    for (let i = 0; i < 5; i++) expect(await v.verify(sign(stranger, adminClaims()))).toBeNull();
    expect(issuer.fetches).toBe(1);

    // 발급처가 키를 바꿨다: 간격이 지나면 새 키를 받아 온다
    const rotated = makeSigner("key-2");
    issuer.keys = [rotated.jwk];
    expect(await v.verify(sign(rotated, adminClaims()))).toBeNull();
    now += 61_000;
    expect(await v.verify(sign(rotated, adminClaims()))).not.toBeNull();
    expect(issuer.fetches).toBe(2);
    // 바뀐 뒤에는 옛 키로 서명한 토큰을 받지 않는다
    expect(await v.verify(sign(signer, adminClaims()))).toBeNull();
  });

  it("발급처에서 지운 키는 10분 안에 여기서도 믿지 않는다 (모르는 kid가 오지 않아도)", async () => {
    let now = Date.now();
    const removed = makeSigner("key-old");
    issuer.keys = [signer.jwk, removed.jwk];
    const v = verifier(() => now);
    // 검증기의 시계(now)에 맞춰 만료를 잡은 토큰
    const fresh = (): Claims => ({ ...adminClaims(), exp: Math.floor(now / 1000) + 300 });
    expect(await v.verify(sign(removed, fresh()))).not.toBeNull();
    // 유출된 키를 발급처에서 지웠다. 이후 오는 토큰은 모두 아는 kid다.
    issuer.keys = [signer.jwk];
    now += 9 * 60_000;
    expect(await v.verify(sign(removed, fresh()))).not.toBeNull();
    now += 2 * 60_000;
    expect(await v.verify(sign(signer, fresh()))).not.toBeNull();
    expect(await v.verify(sign(removed, fresh()))).toBeNull();
    expect(issuer.fetches).toBe(2);
  });

  it("키를 받지 못하면 이유를 한 줄 알린다 (토큰 내용 없이)", async () => {
    const warnings: string[] = [];
    issuer.down = true;
    const v = new OidcVerifier({ issuer: ISSUER, jwksUrl: issuer.url }, fetch, Date.now, (message) => warnings.push(message));
    const token = sign(signer, adminClaims());
    expect(await v.verify(token)).toBeNull();
    expect(warnings).toEqual(["OIDC signing keys could not be fetched (HTTP 503)"]);
    expect(warnings.join(" ")).not.toContain(token.split(".")[1]);
  });

  it("발급처에 닿지 못하면 null이고, 닿게 되면 곧 다시 받는다. 받아 둔 키는 발급처가 죽어도 쓴다", async () => {
    let now = Date.now();
    issuer.down = true;
    const v = verifier(() => now);
    expect(await v.verify(sign(signer, adminClaims()))).toBeNull();
    issuer.down = false;
    // 키가 하나도 없을 때는 5초 간격
    expect(await v.verify(sign(signer, adminClaims()))).toBeNull();
    now += 5_100;
    expect(await v.verify(sign(signer, adminClaims()))).not.toBeNull();

    issuer.down = true;
    now += 120_000;
    expect(await v.verify(sign(signer, adminClaims()))).not.toBeNull();
    // 모르는 kid가 와서 다시 받기를 시도했다가 실패해도 가진 키는 남는다
    expect(await v.verify(sign(makeSigner("key-x"), adminClaims()))).toBeNull();
    expect(await v.verify(sign(signer, adminClaims()))).not.toBeNull();
  });

  it("서명용이 아닌 키는 쓰지 않는다", async () => {
    issuer.keys = [{ ...signer.jwk, use: "enc" }];
    expect(await verifier().verify(sign(signer, adminClaims()))).toBeNull();
  });
});

describe("발급처가 설정된 설치의 관리 API", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });
  const boot = async () => {
    h = await buildHarness({ env: { OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: issuer.url } });
    return h;
  };
  const get = (token: string, ip = "10.1.1.1") =>
    h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: { authorization: `Bearer ${token}` }, remoteAddress: ip });

  it("관리자 역할이면서 팀원인 사람의 토큰만 통과한다", async () => {
    await boot();
    expect((await get(sign(signer, adminClaims()))).statusCode).toBe(200);
    // 팀원이지만 관리자가 아님
    expect((await get(sign(signer, { ...adminClaims(), realm_access: { roles: [] } }))).statusCode).toBe(401);
    // 관리자 역할은 있는데 팀원 그룹에 없음 (정지된 계정)
    expect((await get(sign(signer, { ...adminClaims(), groups: [] }))).statusCode).toBe(401);
    // 만료
    expect((await get(sign(signer, { ...adminClaims(), exp: nowSeconds() - 60 }))).statusCode).toBe(401);
  });

  it("토큰으로 들어온 변경 요청에는 CSRF 헤더가 필요 없다 (브라우저가 자동으로 붙이는 것이 아니다)", async () => {
    await boot();
    const res = await h.app.inject({
      method: "POST",
      url: "/admin/api/prompts",
      headers: { authorization: `Bearer ${sign(signer, adminClaims())}`, "content-type": "application/json" },
      payload: { name: "p", content: "x" },
    });
    expect(res.statusCode).toBeLessThan(300);
  });

  it("프로그램용 관리자 키(Bearer)는 그대로 통하고, 키로 하는 화면 로그인과 그 쿠키는 꺼진다", async () => {
    await boot();
    expect((await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: adminHeaders })).statusCode).toBe(200);
    const login = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe("key_login_disabled");
    expect(login.headers["set-cookie"]).toBeUndefined();
  });

  it("발급처가 없을 때 키로 만든 세션 쿠키는 발급처를 켠 뒤에는 통하지 않는다", async () => {
    const db = openDatabase(":memory:");
    const dirs = { dataDir: tempDir("oidc-data"), pluginsDir: tempDir("oidc-plugins") };
    const before = new AdminAuth(db, makeConfig(dirs));
    let cookie = "";
    const reply = { header: (_name: string, value: string) => void (cookie = value.split(";")[0]!) } as unknown as FastifyReply;
    before.login({ ip: "10.1.1.1", headers: {}, protocol: "http" } as unknown as FastifyRequest, reply, ADMIN_KEY);
    const withCookie = { ip: "10.1.1.1", headers: { cookie } } as unknown as FastifyRequest;
    expect(await before.authenticate(withCookie)).toBe("cookie");
    // 같은 DB(같은 세션 행)로 발급처를 켠 설치
    const after = new AdminAuth(db, makeConfig({ ...dirs, env: { OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: issuer.url } }));
    expect(await after.authenticate(withCookie)).toBeNull();
  });

  it("틀린 토큰이 아무리 와도 주소가 잠기지 않는다 (중계 서버의 주소 하나로 모든 관리자가 들어온다)", async () => {
    await boot();
    const expired = sign(signer, { ...adminClaims(), exp: nowSeconds() - 60 });
    for (let i = 0; i < 12; i++) expect((await get(expired)).statusCode).toBe(401);
    expect((await get(sign(signer, adminClaims()))).statusCode).toBe(200);
    expect((await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: adminHeaders, remoteAddress: "10.1.1.1" })).statusCode).toBe(200);
    // 틀린 키는 예전처럼 센다
    for (let i = 0; i < 6; i++) await get("not-the-key");
    expect((await get("not-the-key")).statusCode).toBe(429);
  });

  it("발급처가 없는 설치는 JWT 모양의 값도 키로만 본다", async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: "GET", url: "/admin/api/prompts", headers: { authorization: `Bearer ${sign(signer, adminClaims())}` } });
    expect(res.statusCode).toBe(401);
    const login = await h.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-admin-request": "1", "content-type": "application/json" },
      payload: { apiKey: ADMIN_KEY },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe("OIDC 설정", () => {
  const base = { AUTH_DISABLED: "1", SANDBOXD_JWT_SECRET: "s".repeat(40), BROKER_JWT_SECRET: "b".repeat(40), MEMORY_API_KEY: "m".repeat(40) };
  const load = (env: Record<string, string>) => {
    try {
      return loadConfig({ ...base, ...env } as NodeJS.ProcessEnv).auth.oidc;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("둘 다 있거나 둘 다 없어야 한다", () => {
    expect(load({})).toBeUndefined();
    expect(load({ OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: "http://keycloak:8080/certs" })).toEqual({ issuer: ISSUER, jwksUrl: "http://keycloak:8080/certs" });
    expect(load({ OIDC_ISSUER: ISSUER })).toContain("Set both OIDC_ISSUER and OIDC_JWKS_URL");
    expect(load({ OIDC_JWKS_URL: "http://keycloak:8080/certs" })).toContain("Set both OIDC_ISSUER and OIDC_JWKS_URL");
    for (const bad of ["keycloak:8080/certs", "http://", "ftp://keycloak/certs"]) {
      expect(load({ OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: bad }), bad).toContain("OIDC_JWKS_URL must be an http(s) URL");
    }
    // 관리자 키가 JWT 모양이면 프로그램용 키가 조용히 막히므로 시작하지 않는다 (발급처가 없으면 상관없다)
    const jwtShaped = { ADMIN_API_KEY: "sk-abcdefghijklmnop.qrstuvwxyz012345.6789abcdefghijkl" };
    expect(load({ ...jwtShaped, OIDC_ISSUER: ISSUER, OIDC_JWKS_URL: "http://keycloak:8080/certs" })).toContain("ADMIN_API_KEY must not have the shape of a JWT");
    expect(load(jwtShaped)).toBeUndefined();
  });
});
