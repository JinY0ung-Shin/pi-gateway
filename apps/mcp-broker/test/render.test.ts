import { findLiteralCredentials, McpServerConfig } from "@pi-gateway/shared";
import { describe, expect, it } from "vitest";
import {
  checkStdioCommand,
  ConfigError,
  effectiveScope,
  MissingSessionError,
  renderTransport,
  scopeKey,
} from "../src/render.js";

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
        type: "stdio",
        command: "node",
        args: ["server.js", "--user={{user}}"],
        env: { TOKEN: "{{secret:TOKEN}}", FWD: "{{ctx.header:x-user-token}}", THREAD: "{{metadata:thread_id}}", SID: "{{session}}" },
      },
    });
    const out = renderTransport(
      config,
      { sub: "alice", sid: "s1", ctx: { headers: { "x-user-token": "utok-123456" }, metadata: { thread_id: "t9" } } },
      new Map([["TOKEN", "sekret-value"]]),
    );
    expect(out.transport).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js", "--user=alice"],
      env: { TOKEN: "sekret-value", FWD: "utok-123456", THREAD: "t9", SID: "s1" },
    });
    expect(out.credentials.sort()).toEqual(["sekret-value", "utok-123456"]);
    expect(out.missingSecrets).toEqual([]);
  });

  it("없는 비밀키와 없는 선택 값을 구분해 알려준다", () => {
    const config = http({ Authorization: "Bearer {{secret:TOKEN}}", "X-Opt": "{{ctx.header:x-missing}}" });
    const out = renderTransport(config, { sub: "a" }, new Map());
    expect(out.missingSecrets).toEqual(["TOKEN"]);
    expect(out.missingOptional).toEqual(["{{ctx.header:x-missing}}"]);
  });

  it("{{plugin_root}}가 남아 있으면 거부한다", () => {
    const config = McpServerConfig.parse({
      id: "p",
      runIn: "broker",
      transport: { type: "stdio", command: "node", args: ["{{plugin_root}}/server.js"] },
    });
    expect(() => renderTransport(config, { sub: "a" }, new Map())).toThrow(ConfigError);
  });
});

describe("admin input checks", () => {
  it("실행 시 패키지를 내려받는 명령을 거부한다", () => {
    expect(checkStdioCommand("npx", [])).toMatch(/downloads packages/);
    expect(checkStdioCommand("/usr/bin/uvx", [])).toMatch(/downloads packages/);
    expect(checkStdioCommand("node", [])).toBeNull();
    expect(checkStdioCommand("python3", ["node"])).toMatch(/allowlist/i);
    expect(checkStdioCommand("/usr/local/bin/node", ["node"])).toBeNull();
  });

  it("자격증명 자리의 리터럴 값을 거부한다", () => {
    expect(findLiteralCredentials(http({ Authorization: "Bearer ghp_literal" }))).toHaveLength(1);
    expect(findLiteralCredentials(http({ Authorization: "Bearer {{secret:T}}" }))).toEqual([]);
    expect(findLiteralCredentials(http({ "X-Request-Source": "pi-gateway" }))).toEqual([]);
    const stdio = McpServerConfig.parse({
      id: "s",
      runIn: "broker",
      transport: { type: "stdio", command: "node", env: { GITHUB_TOKEN: "literal", LOG_LEVEL: "debug", API_KEY: "{{secret:K}}" } },
    });
    expect(findLiteralCredentials(stdio)).toEqual(["env 'GITHUB_TOKEN' holds a literal credential; use {{secret:NAME}}"]);
    const url = McpServerConfig.parse({
      id: "u",
      runIn: "broker",
      transport: { type: "http", url: "https://example.com/mcp?api_key=abc&page=1", headers: {} },
    });
    expect(findLiteralCredentials(url)).toHaveLength(1);
  });
});
