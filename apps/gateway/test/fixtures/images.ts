import { crc32, deflateSync } from "node:zlib";

/** 테스트용 이미지 바이트 */

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = 8; // bit depth
  d[9] = 2; // RGB
  return chunk("IHDR", d);
}

/** 정상적인 작은 PNG (width×height, 회색) */
export function tinyPng(width = 2, height = 2): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([SIG, ihdr(width, height), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * 압축 폭탄 PNG: 헤더는 width×height를 선언하고 IDAT에는 0 몇 줄만 압축해 넣는다.
 * 파일은 작지만 디코더는 width×height×3 바이트를 잡는다. (gateway는 헤더만 보고 거절해야 한다)
 */
export function bombPng(width = 20000, height = 20000): Buffer {
  const row = Buffer.alloc(1 + width * 3, 0);
  const raw = Buffer.concat(Array.from({ length: 4 }, () => row));
  return Buffer.concat([SIG, ihdr(width, height), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** GIF: 화면은 1×1인데 프레임은 크게 선언한 것 */
export function gifWithHugeFrame(width = 30000, height = 30000): Buffer {
  const header = Buffer.from("GIF89a", "latin1");
  const screen = Buffer.from([1, 0, 1, 0, 0x00, 0, 0]); // 1x1, 전역 팔레트 없음
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(width, 5);
  desc.writeUInt16LE(height, 7);
  desc[9] = 0;
  const data = Buffer.from([0x02, 0x01, 0x00, 0x00]); // LZW min size 2, 1바이트 블록, 끝
  return Buffer.concat([header, screen, desc, data, Buffer.from([0x3b])]);
}

export function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function webpVp8xHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
  return b;
}

export function bmpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(54);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(-height, 22);
  return b;
}
