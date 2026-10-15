import { describe, expect, it } from "vitest";
import {
  AUD_BROKER,
  AUD_SANDBOXD,
  anonPrincipal,
  isValidPrincipal,
  isValidUserId,
  jwtSecretBytes,
  McpServerConfig,
  mcpToolName,
  renderTemplate,
  requiredSecretNames,
  signInternalToken,
  userKey,
  verifyInternalToken,
} from "@pi-gateway/shared";

const secret = jwtSecretBytes("x".repeat(32));
const otherSecret = jwtSecretBytes("y".repeat(32));

describe("principal / userKey", () => {
  it("익명 principal은 실제 사용자 id 패턴과 겹치지 않는다", () => {
    const anon = anonPrincipal("123e4567-e89b-12d3-a456-426614174000");
    expect(isValidUserId(anon)).toBe(false);
    expect(isValidPrincipal(anon)).toBe(true);
    expect(isValidPrincipal("alice@example.com")).toBe(true);
    expect(isValidPrincipal("../etc")).toBe(false);
  });

  it("userKey는 결정적이고 원래 id를 드러내지 않는다", () => {
    expect(userKey("alice")).toBe(userKey("alice"));
    expect(userKey("alice")).not.toBe(userKey("bob"));
    expect(userKey("alice")).toMatch(/^u-[0-9a-f]{24}$/);
  });
});

describe("internal JWT", () => {
  it("서명·검증하고 claims를 돌려준다", async () => {
    const token = await signInternalToken(secret, AUD_BROKER, {
      sub: "alice",
      sid: "s1",
      ctx: { headers: { "x-user-token": "t" } },
    });
    const claims = await verifyInternalToken(secret, AUD_BROKER, token);
    expect(claims.sub).toBe("alice");
    expect(claims.sid).toBe("s1");
    expect(claims.ctx?.headers?.["x-user-token"]).toBe("t");
  });

  it("audience나 비밀키가 다르면 거부한다", async () => {
    const token = await signInternalToken(secret, AUD_BROKER, { sub: "alice" });
    await expect(verifyInternalToken(secret, AUD_SANDBOXD, token)).rejects.toThrow();
    await expect(verifyInternalToken(otherSecret, AUD_BROKER, token)).rejects.toThrow();
  });

  it("너무 긴 TTL은 만들 수 없다", async () => {
    await expect(signInternalToken(secret, AUD_BROKER, { sub: "a" }, 3600)).rejects.toThrow();
  });
});

describe("MCP server config", () => {
  const base = {
    id: "github",
    runIn: "broker" as const,
    transport: { type: "http" as const, url: "https://example.com/mcp", headers: { Authorization: "Bearer {{secret:TOKEN}}" } },
  };

  it("broker 서버는 secret 자리표시자를 쓸 수 있다", () => {
    const config = McpServerConfig.parse(base);
    expect(requiredSecretNames(config)).toEqual(["TOKEN"]);
  });

  it("sandbox 서버는 secret·header 자리표시자를 쓸 수 없다", () => {
    const result = McpServerConfig.safeParse({
      ...base,
      runIn: "sandbox",
      transport: { type: "stdio", command: "node", env: { T: "{{secret:TOKEN}}", U: "{{ctx.header:X-Token}}" } },
    });
    expect(result.success).toBe(false);
  });

  it("stdio 서버가 metadata를 쓰면 per-session이어야 한다", () => {
    const transport = { type: "stdio" as const, command: "node", env: { THREAD_ID: "{{metadata:thread_id}}" } };
    expect(McpServerConfig.safeParse({ id: "s", runIn: "sandbox", transport }).success).toBe(false);
    expect(McpServerConfig.safeParse({ id: "s", runIn: "sandbox", scope: "per-session", transport }).success).toBe(true);
  });

  it("알 수 없는 자리표시자는 거부한다", () => {
    const result = McpServerConfig.safeParse({
      ...base,
      transport: { type: "http", url: "https://example.com/{{oops}}", headers: {} },
    });
    expect(result.success).toBe(false);
  });

  it("renderTemplate은 값을 채우고 빠진 것을 알려준다", () => {
    const out = renderTemplate("Bearer {{secret:A}} for {{user}} {{ctx.header:X-T}} {{metadata:m}}", {
      user: "alice",
      secret: (n) => (n === "A" ? "s3cr3t" : undefined),
      headers: { "x-t": "h" },
    });
    expect(out.value).toBe("Bearer s3cr3t for alice h ");
    expect(out.missing).toEqual(["{{metadata:m}}"]);
  });

  it("도구 이름은 64자 이하의 안전한 문자만 쓴다", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("srv", "a.b/c")).toBe("mcp__srv__a_b_c");
    expect(mcpToolName("srv", "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});
