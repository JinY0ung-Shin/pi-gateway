import { describe, expect, it } from "vitest";
import { checkImage, guardImageBlocks, imageInfo, MAX_IMAGE_BYTES } from "../src/tools/image-guard.js";
import { bmpHeader, bombPng, gifWithHugeFrame, jpegHeader, tinyPng, webpVp8xHeader } from "./fixtures/images.js";

describe("image guard (header parsing, no decoding)", () => {
  it("reads dimensions from PNG, JPEG, GIF, WebP and BMP headers", () => {
    expect(imageInfo(tinyPng(3, 2))).toMatchObject({ format: "png", width: 3, height: 2 });
    expect(imageInfo(jpegHeader(640, 480))).toMatchObject({ format: "jpeg", width: 640, height: 480 });
    expect(imageInfo(webpVp8xHeader(1000, 2000))).toMatchObject({ format: "webp", width: 1000, height: 2000 });
    expect(imageInfo(bmpHeader(800, 600))).toMatchObject({ format: "bmp", width: 800, height: 600 });
    // GIF는 가장 큰 프레임 크기를 본다 (화면 크기가 1×1이어도)
    expect(imageInfo(gifWithHugeFrame(30000, 30000))).toMatchObject({ format: "gif", width: 30000, height: 30000 });
  });

  it("accepts normal images and rejects decompression bombs before decoding", () => {
    expect(checkImage(tinyPng()).ok).toBe(true);
    const bomb = bombPng();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const verdict = checkImage(bomb);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toContain("20000x20000");
    expect(checkImage(gifWithHugeFrame()).ok).toBe(false);
    expect(checkImage(jpegHeader(10000, 10000)).ok).toBe(false);
    expect(checkImage(webpVp8xHeader(16384, 16384)).ok).toBe(false);
    expect(checkImage(bmpHeader(6000, 6000)).ok).toBe(false);
  });

  it("rejects malformed or unknown image headers instead of handing them to a decoder", () => {
    expect(checkImage(Buffer.from("GIF89a")).ok).toBe(false);
    expect(checkImage(Buffer.concat([tinyPng().subarray(0, 12)])).ok).toBe(false);
    expect(checkImage(Buffer.from("not an image")).ok).toBe(false);
  });

  it("guardImageBlocks replaces unsafe image blocks with a text notice and fixes the MIME type", () => {
    const out = guardImageBlocks(
      [
        { type: "text" as const, text: "hello" },
        { type: "image" as const, data: bombPng().toString("base64"), mimeType: "image/png" },
        { type: "image" as const, data: tinyPng().toString("base64"), mimeType: "image/jpeg" },
        { type: "image" as const, data: "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 100), mimeType: "image/png" },
      ],
      "srv/tool",
    );
    expect(out[0]).toEqual({ type: "text", text: "hello" });
    expect(out[1]).toMatchObject({ type: "text" });
    expect((out[1] as { text: string }).text).toContain("Image omitted (srv/tool)");
    expect(out[2]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(out[3]).toMatchObject({ type: "text" });
  });
});
