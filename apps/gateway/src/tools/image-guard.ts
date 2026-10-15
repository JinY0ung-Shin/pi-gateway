/**
 * 이미지 폭탄 방어.
 * pi는 도구 결과의 이미지를 gateway 프로세스 안에서 디코딩·리사이즈한다 (read의 autoResize,
 * AgentSession._afterToolCall). 크기 확인이 없어서, 작은 파일이 큰 해상도를 선언하면
 * (예: 389KB PNG가 20000×20000) 디코딩만으로 수 GB 메모리를 쓴다.
 * 그래서 pi에 넘기기 전에 헤더만 읽어 해상도·바이트 수를 확인하고, 넘으면 텍스트 안내로 바꾼다.
 * 형식을 알 수 없거나 헤더가 깨진 이미지도 디코딩하지 않는다.
 */

export const MAX_IMAGE_PIXELS = 25_000_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageInfo {
  format: ImageFormat;
  mimeType: string;
  width: number;
  height: number;
}

export type ImageVerdict = { ok: true; info: ImageInfo } | { ok: false; reason: string };

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 바이트 앞부분으로 형식을 고른다 (선언된 MIME 타입은 믿지 않는다). */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return null;
}

function pngSize(b: Buffer): [number, number] | null {
  if (b.length < 24 || b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function jpegSize(b: Buffer): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1]!;
    // 채움 바이트(0xFF 연속)는 건너뛴다
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1]!;
    }
    // 길이가 없는 marker (RSTn, SOI, EOI, TEM)
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15 (DHT=C4, JPG=C8, DAC=CC 제외)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + len;
  }
  return null;
}

/** GIF는 프레임마다 크기가 다를 수 있어 모든 image descriptor를 본다. 가장 큰 프레임(또는 화면) 크기를 돌려준다. */
function gifSize(b: Buffer): [number, number] | null {
  if (b.length < 13) return null;
  let maxW = b.readUInt16LE(6);
  let maxH = b.readUInt16LE(8);
  let i = 13;
  const flags = b[10]!;
  if (flags & 0x80) i += 3 * (1 << ((flags & 0x07) + 1));
  const skipSubBlocks = () => {
    while (i < b.length) {
      const size = b[i]!;
      i++;
      if (size === 0) return true;
      i += size;
    }
    return false;
  };
  while (i < b.length) {
    const block = b[i]!;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      i += 2;
      if (!skipSubBlocks()) return null;
    } else if (block === 0x2c) {
      if (i + 10 > b.length) return null;
      const w = b.readUInt16LE(i + 5);
      const h = b.readUInt16LE(i + 7);
      if (w * h > maxW * maxH) {
        maxW = w;
        maxH = h;
      }
      const f = b[i + 9]!;
      i += 10;
      if (f & 0x80) i += 3 * (1 << ((f & 0x07) + 1));
      i += 1; // LZW 최소 코드 크기
      if (!skipSubBlocks()) return null;
    } else {
      return null;
    }
  }
  return [maxW, maxH];
}

function webpSize(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = b.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const w = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const h = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return [w, h];
  }
  if (chunk === "VP8X") {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return [w, h];
  }
  return null;
}

function bmpSize(b: Buffer): [number, number] | null {
  if (b.length < 26) return null;
  const header = b.readUInt32LE(14);
  if (header === 12) return [b.readUInt16LE(18), b.readUInt16LE(20)];
  if (header < 40) return null;
  return [Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22))];
}

export function imageInfo(buf: Buffer): ImageInfo | null {
  const format = sniffImageFormat(buf);
  if (!format) return null;
  const size =
    format === "png" ? pngSize(buf) : format === "jpeg" ? jpegSize(buf) : format === "gif" ? gifSize(buf) : format === "webp" ? webpSize(buf) : bmpSize(buf);
  if (!size) return null;
  return { format, mimeType: MIME[format], width: size[0], height: size[1] };
}

/** pi에 넘겨도 되는 이미지인지 */
export function checkImage(buf: Buffer): ImageVerdict {
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: `image is ${(buf.length / 1048576).toFixed(1)} MB (limit ${MAX_IMAGE_BYTES / 1048576} MB)` };
  const info = imageInfo(buf);
  if (!info) return { ok: false, reason: "unrecognized or malformed image header" };
  if (info.width <= 0 || info.height <= 0) return { ok: false, reason: "image has no dimensions" };
  const pixels = info.width * info.height;
  if (pixels > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: `image is ${info.width}x${info.height} (${(pixels / 1e6).toFixed(1)} MP, limit ${MAX_IMAGE_PIXELS / 1e6} MP)` };
  }
  return { ok: true, info };
}

export function imageNotice(source: string, reason: string): string {
  return `[Image omitted (${source}): ${reason}. It was not decoded. Inspect or downscale it with bash inside the sandbox (for example ImageMagick or Python PIL) and read the smaller file.]`;
}

type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 도구 결과의 이미지 블록을 검사하고, 안전하지 않은 것은 텍스트 안내로 바꾼다 (MCP 결과용). */
export function guardImageBlocks<T extends ContentBlock>(content: T[], source: string): (T | { type: "text"; text: string })[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    // base64를 풀기 전에 대략 크기로 먼저 거른다.
    if ((block.data.length * 3) / 4 > MAX_IMAGE_BYTES + 4) {
      return { type: "text" as const, text: imageNotice(source, `image is larger than ${MAX_IMAGE_BYTES / 1048576} MB`) };
    }
    const verdict = checkImage(Buffer.from(block.data, "base64"));
    if (!verdict.ok) return { type: "text" as const, text: imageNotice(source, verdict.reason) };
    // 실제 형식에 맞는 MIME 타입으로 바로잡는다 (pi는 선언된 MIME 타입으로 디코더를 고른다).
    return { ...block, mimeType: verdict.info.mimeType };
  });
}
