import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  LLM_BASE_URL: "http://llm:8000/v1",
  LLM_MODELS: JSON.stringify([{ id: "m", contextWindow: 1000, maxTokens: 100 }]),
  API_KEY: "service-key-0123456789",
  SANDBOXD_JWT_SECRET: "x".repeat(40),
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

  it("rejects TRUST_PROXY=true together with ADMIN_ALLOWED_CIDRS (X-Forwarded-For would be spoofable)", () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: "true", ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" })).toThrow(/cannot be combined with ADMIN_ALLOWED_CIDRS/);
    // 프록시 주소 목록이면 함께 쓸 수 있다
    const c = loadConfig({ ...base, TRUST_PROXY: "172.18.0.1", ADMIN_ALLOWED_CIDRS: "10.0.0.0/8" });
    expect(c.trustProxy).toEqual(["172.18.0.1"]);
    expect(c.admin.allowedCidrs).toEqual(["10.0.0.0/8"]);
    // CIDR 제한이 없으면 true도 허용한다 (프록시 뒤에서만 쓰는 경우)
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
  });

  it("treats empty env strings as unset", () => {
    const c = loadConfig({ ...base, DEFAULT_MODEL: "", LLM_API: "", HOST: "", DATA_DIR: "" });
    expect(c.llm.defaultModel).toBe("m");
    expect(c.llm.api).toBe("openai-completions");
    expect(c.host).toBe("0.0.0.0");
    expect(c.dataDir).toBe("/data");
  });
});
