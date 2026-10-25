import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, secretVariants } from "../src/redact.js";
import { capResult } from "../src/service.js";

const SECRET = "ghp_Sup3rS3cretValue/+=?&x";

describe("Redactor", () => {
  const r = new Redactor([SECRET]);
  const bytes = Buffer.from(SECRET, "utf8");

  it.each([
    ["raw", SECRET],
    ["base64", bytes.toString("base64")],
    ["base64 without padding", bytes.toString("base64").replace(/=+$/, "")],
    ["base64url", bytes.toString("base64url")],
    ["url-encoded", encodeURIComponent(SECRET)],
    ["form-encoded", encodeURIComponent(SECRET).replace(/%20/g, "+")],
    ["hex", bytes.toString("hex")],
    ["HEX", bytes.toString("hex").toUpperCase()],
    ["json-escaped", JSON.stringify(SECRET).slice(1, -1)],
  ])("%s 형태를 가린다", (_label, encoded) => {
    const out = r.redact(`before ${encoded} after`);
    expect(out).toBe(`before ${REDACTED} after`);
  });

  it.each([0, 1, 2, 3, 4, 5])("다른 바이트와 함께 base64로 인코딩된 경우도 가린다 (앞 %i바이트)", (prefixLen) => {
    const prefix = "u".repeat(prefixLen) + ":";
    const encoded = Buffer.from(`${prefix}${SECRET}`, "utf8").toString("base64");
    const out = r.redact(`Authorization: Basic ${encoded}`);
    expect(out).toContain(REDACTED);
    // 남은 부분을 디코딩해도 비밀값 조각이 남지 않아야 한다.
    for (const variant of secretVariants(SECRET)) expect(out).not.toContain(variant);
  });

  it("JSON 값 전체(키 포함)를 깊게 가리고 원본은 그대로 둔다", () => {
    const value = { content: [{ type: "text", text: `x${SECRET}y` }], structuredContent: { [SECRET]: [SECRET, 1, true, null] } };
    const out = r.redactDeep(value);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain(REDACTED);
    expect(value.content[0]!.text).toContain(SECRET);
  });

  it("너무 짧은 값은 건너뛴다 (결과를 망가뜨리지 않으려고)", () => {
    const short = new Redactor(["abc"]);
    expect(short.active).toBe(false);
    expect(short.redact("abc abc")).toBe("abc abc");
  });

  it("긴 형태를 먼저 가린다", () => {
    const two = new Redactor(["abcd", "abcdefgh"]);
    expect(two.redact("abcdefgh")).toBe(REDACTED);
  });
});

describe("capResult", () => {
  it("한도를 넘으면 텍스트만 남겨 자르고 표시를 붙인다", () => {
    const big = { content: [{ type: "text" as const, text: "y".repeat(5000) }], isError: false };
    const out = capResult(big, 2048);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(5000);
    expect(out.content[0]!.type).toBe("text");
    expect((out.content[0] as { text: string }).text).toMatch(/^\[mcp-broker: result truncated/);
  });

  it("한도 안이면 그대로 돌려준다", () => {
    const small = { content: [{ type: "text" as const, text: "ok" }] };
    expect(capResult(small, 2048)).toBe(small);
  });
});
