import { describe, expect, it } from "vitest";
import { capResult } from "../src/service.js";

const limits = { maxResultBytes: 2048, maxFileBytes: 3000 };

describe("capResult", () => {
  it("한도를 넘으면 텍스트만 남겨 자르고 표시를 붙인다", () => {
    const big = { content: [{ type: "text" as const, text: "y".repeat(5000) }], isError: false };
    const out = capResult(big, limits);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(5000);
    expect(out.content[0]!.type).toBe("text");
    expect((out.content[0] as { text: string }).text).toMatch(/^\[mcp-broker: result truncated/);
  });

  const withFile = (chars: number) => ({
    content: [{ type: "text" as const, text: "meta" }, { type: "resource" as const, resource: { uri: "artifact://a", blob: "A".repeat(chars) } }],
  });

  it("파일은 따로 센다: 합계가 파일 한도 안이면 결과 한도를 넘어도 그대로 돌려준다", () => {
    const ok = withFile(4000);
    expect(capResult(ok, limits)).toBe(ok);
    // 한도와 같은 크기는 통과한다 (base64 끝의 `=`는 바이트가 아니다)
    const exact = { content: [{ type: "resource" as const, resource: { uri: "artifact://a", blob: Buffer.alloc(3200).toString("base64") } }] };
    expect(capResult(exact, { maxResultBytes: 2048, maxFileBytes: 3200 })).toBe(exact);
    expect(capResult(exact, { maxResultBytes: 2048, maxFileBytes: 3199 }).isError).toBe(true);
  });

  it("파일 한도를 넘으면 파일을 빼고 오류로 돌려준다", () => {
    const out = capResult(withFile(4004), limits);
    expect(out.isError).toBe(true);
    expect(out.content).toEqual([
      {
        type: "text",
        text: "[mcp-broker: result truncated — its files are 3003 bytes, over the 3000-byte limit; its images and files were not delivered]\n\nmeta\n[resource content omitted]",
      },
    ]);
  });

  it("결과 한도를 넘어 이미지가 빠져도 오류다. 텍스트만 잘린 결과는 오류가 아니다", () => {
    const image = { content: [{ type: "image" as const, data: "A".repeat(5000), mimeType: "image/png" }] };
    expect(capResult(image, limits).isError).toBe(true);
    expect(capResult({ content: [{ type: "text" as const, text: "y".repeat(5000) }] }, limits).isError).toBe(false);
  });

  it("한도 안이면 그대로 돌려준다", () => {
    const small = { content: [{ type: "text" as const, text: "ok" }] };
    expect(capResult(small, limits)).toBe(small);
  });
});
