import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { auditSecretFiles, loadBrokerConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-broker-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function secretFile(name: string, content: string, mode: number): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("auditSecretFiles", () => {
  const uid = process.getuid!();

  it("소유자만 읽을 수 있는 파일은 통과한다", () => {
    const env = {
      BROKER_JWT_SECRET_FILE: secretFile("jwt-ok", "x".repeat(40), 0o400),
      BROKER_ADMIN_TOKEN_FILE: secretFile("admin-ok", "y".repeat(40), 0o600),
      BROKER_KEK_FILE: secretFile("kek-ok", randomBytes(32).toString("base64"), 0o400),
    };
    expect(auditSecretFiles(env, uid)).toEqual({ problems: [], warnings: [] });
  });

  it("group/other가 읽을 수 있으면 문제로 본다 (0444 Docker secret 기본값 포함)", () => {
    const env = {
      BROKER_ADMIN_TOKEN_FILE: secretFile("admin-world", "y".repeat(40), 0o444),
      BROKER_KEK_FILE: secretFile("kek-group", randomBytes(32).toString("base64"), 0o640),
    };
    const { problems } = auditSecretFiles(env, uid);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/BROKER_ADMIN_TOKEN_FILE .* mode 0444/);
    expect(problems[1]).toMatch(/BROKER_KEK_FILE .* mode 0640/);
  });

  it("broker uid 소유가 아니면 문제로 본다", () => {
    const env = { BROKER_JWT_SECRET_FILE: secretFile("jwt-owner", "x".repeat(40), 0o400) };
    const { problems } = auditSecretFiles(env, uid + 1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/owned by uid/);
  });

  it("읽을 수 없는 파일, 환경변수 비밀값을 알려준다", () => {
    const { problems, warnings } = auditSecretFiles({ BROKER_KEK_FILE: join(dir, "missing"), BROKER_JWT_SECRET: "x".repeat(40) }, uid);
    expect(problems[0]).toMatch(/cannot be read/);
    expect(warnings[0]).toMatch(/BROKER_JWT_SECRET is passed as an environment variable/);
  });
});

describe("loadBrokerConfig", () => {
  const base = {
    BROKER_JWT_SECRET: "j".repeat(40),
    BROKER_ADMIN_TOKEN: "a".repeat(40),
    BROKER_KEK: randomBytes(32).toString("base64"),
  };

  it("기본값을 채운다", () => {
    const config = loadBrokerConfig(base);
    expect(config.port).toBe(7080);
    expect(config.adminPort).toBe(7081);
    expect(config.stdio.uidRange).toBeNull();
    expect(config.kek).toHaveLength(32);
  });

  it("잘못된 값을 거부한다", () => {
    expect(() => loadBrokerConfig({ ...base, BROKER_KEK: "short" })).toThrow(/32 bytes/);
    expect(() => loadBrokerConfig({ ...base, BROKER_ADMIN_TOKEN: "short" })).toThrow(/at least 32/);
    expect(() => loadBrokerConfig({ ...base, BROKER_STDIO_UID_RANGE: "10-5" })).toThrow();
    expect(loadBrokerConfig({ ...base, BROKER_STDIO_UID_RANGE: "20000-20999" }).stdio.uidRange).toEqual({ start: 20000, end: 20999 });
  });
});
