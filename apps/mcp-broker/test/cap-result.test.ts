import { describe, expect, it } from "vitest";
import { capResult } from "../src/service.js";

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
