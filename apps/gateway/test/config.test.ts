import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  API_KEY: "service-key-0123456789",
  SANDBOXD_JWT_SECRET: "x".repeat(40),
  BROKER_JWT_SECRET: "y".repeat(40),
};

describe("gateway config", () => {
  it("TRUST_PROXY accepts false and IP lists, and rejects true and hop counts", () => {
    expect(loadConfig({ ...base }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "10.0.0.0/8, 172.18.0.5" }).trustProxy).toEqual(["10.0.0.0/8", "172.18.0.5"]);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY must be false or/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "1" })).toThrow(/TRUST_PROXY must be false or/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: "2" })).toThrow(/TRUST_PROXY must be false or/);
  });

  it("uses the compose broker addresses by default and requires the broker JWT secret", () => {
    const { broker } = loadConfig({ ...base });
    expect([broker.url, broker.adminUrl]).toEqual(["http://mcp-broker:7080", "http://mcp-broker:7081"]);
    expect(() => loadConfig({ ...base, BROKER_JWT_SECRET: "" })).toThrow(/BROKER_JWT_SECRET/);
  });

  it("reads PLUGIN_GIT_TOKEN_FILE and treats an empty file as unset", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gw-config-")), "plugin_git_token");
    writeFileSync(file, "");
    expect(loadConfig({ ...base, PLUGIN_GIT_TOKEN_FILE: file }).pluginGitToken).toBeUndefined();
    writeFileSync(file, "ghp_token\n");
    expect(loadConfig({ ...base, PLUGIN_GIT_TOKEN_FILE: file }).pluginGitToken).toBe("ghp_token");
  });

  it("treats empty env strings as unset", () => {
    const c = loadConfig({ ...base, HOST: "", DATA_DIR: "" });
    expect(c.host).toBe("0.0.0.0");
    expect(c.dataDir).toBe("/data");
  });
});
