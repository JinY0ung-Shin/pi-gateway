import { findLiteralCredentials, McpServerConfig } from "@pi-gateway/shared";
import { describe, expect, it } from "vitest";
import { effectiveScope, MissingSessionError, renderTransport, scopeKey } from "../src/render.js";

const http = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  McpServerConfig.parse({ id: "h", runIn: "broker", transport: { type: "http", url: "https://example.com/mcp", headers }, ...extra });

describe("effectiveScope / scopeKey", () => {
  it("http 서버가 사용자 헤더를 쓰면 shared로 설정해도 per-user가 된다", () => {
    expect(effectiveScope(http({ "X-User": "{{user}}" }))).toBe("per-user");
    expect(effectiveScope(http({ "X-Token": "{{ctx.header:x-token}}" }))).toBe("per-user");
    expect(effectiveScope(http({ "X-Thread": "{{metadata:thread_id}}" }))).toBe("per-session");
    expect(effectiveScope(http({ Authorization: "Bearer {{secret:T}}" }))).toBe("shared");
    expect(effectiveScope(http({}, { scope: "per-session" }))).toBe("per-session");
  });

  it("scopeKey는 사용자·세션을 섞지 않는다", () => {
    expect(scopeKey("shared", { sub: "alice" })).toBe(scopeKey("shared", { sub: "bob" }));
    expect(scopeKey("per-user", { sub: "alice" })).not.toBe(scopeKey("per-user", { sub: "bob" }));
    expect(scopeKey("per-session", { sub: "alice", sid: "1" })).not.toBe(scopeKey("per-session", { sub: "alice", sid: "2" }));
    expect(() => scopeKey("per-session", { sub: "alice" })).toThrow(MissingSessionError);
  });
});

describe("renderTransport", () => {
  it("비밀키·사용자·헤더·metadata를 채우고 자격증명을 모은다", () => {
    const config = McpServerConfig.parse({
      id: "s",
      runIn: "broker",
      scope: "per-session",
      transport: {
        type: "http",
        url: "https://example.com/mcp?user={{user}}",
        headers: { Authorization: "Bearer {{secret:TOKEN}}", FWD: "{{ctx.header:x-user-token}}", THREAD: "{{metadata:thread_id}}", SID: "{{session}}" },
      },
    });
    const out = renderTransport(
      config,
      { sub: "alice", sid: "s1", ctx: { headers: { "x-user-token": "utok-123456" }, metadata: { thread_id: "t9" } } },
      new Map([["TOKEN", "sekret-value"]]),
    );
    expect(out.transport).toEqual({
      url: "https://example.com/mcp?user=alice",
      headers: { Authorization: "Bearer sekret-value", FWD: "utok-123456", THREAD: "t9", SID: "s1" },
    });
    expect(out.headerCredentials).toEqual(["utok-123456"]);
  });
});

describe("admin input checks", () => {
  it("자격증명 자리의 리터럴 값을 거부한다", () => {
    expect(findLiteralCredentials(http({ Authorization: "Bearer ghp_literal" }))).toHaveLength(1);
    expect(findLiteralCredentials(http({ Authorization: "Bearer {{secret:T}}" }))).toEqual([]);
    expect(findLiteralCredentials(http({ "X-Request-Source": "pi-gateway" }))).toEqual([]);
    const url = McpServerConfig.parse({
      id: "u",
      runIn: "broker",
      transport: { type: "http", url: "https://example.com/mcp?api_key=abc&page=1", headers: {} },
    });
    expect(findLiteralCredentials(url)).toHaveLength(1);
  });
});
