import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadBrokerConfig } from "../src/config.js";

describe("loadBrokerConfig", () => {
  const base = {
    BROKER_JWT_SECRET: "j".repeat(40),
    BROKER_KEK: randomBytes(32).toString("base64"),
  };

  it("기본값을 채운다", () => {
    const config = loadBrokerConfig(base);
    expect(config.port).toBe(7080);
    expect(config.adminPort).toBe(7081);
    expect(config.kek).toHaveLength(32);
  });

  it("잘못된 값을 거부한다", () => {
    expect(() => loadBrokerConfig({ ...base, BROKER_KEK: "short" })).toThrow(/32 bytes/);
    expect(() => loadBrokerConfig({ ...base, BROKER_JWT_SECRET: "short" })).toThrow(/at least 32 bytes/);
  });
});
