import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  API_KEY: "service-key-0123456789",
  SANDBOXD_JWT_SECRET: "x".repeat(40),
  BROKER_URL: "http://mcp-broker:7080",
  BROKER_JWT_SECRET: "y".repeat(40),
  BROKER_ADMIN_TOKEN: "broker-admin-token-0123456789",
};

describe("gateway config", () => {
  it("TRUST_PROXY accepts false/true/IP lists and rejects hop counts (Fastify ignores them)", () => {
    expect(loadConfig({ ...base }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: "10.0.0.0/8, 172.18.0.5" }).trustProxy).toEqual(["10.0.0.0/8", "172.18.0.5"]);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "1" })).toThrow(/hop counts are not supported/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "2" })).toThrow(/hop counts are not supported/);
  });

  it("requires the MCP broker", () => {
    expect(() => loadConfig({ ...base, BROKER_URL: "" })).toThrow(/BROKER_URL/);
    expect(() => loadConfig({ ...base, BROKER_ADMIN_TOKEN: "" })).toThrow(/BROKER_ADMIN_TOKEN/);
  });

  it("treats empty env strings as unset", () => {
    const c = loadConfig({ ...base, HOST: "", DATA_DIR: "" });
    expect(c.host).toBe("0.0.0.0");
    expect(c.dataDir).toBe("/data");
  });
});
