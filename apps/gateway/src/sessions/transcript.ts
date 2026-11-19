import { existsSync, readFileSync } from "node:fs";
import { type FileEntry, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "./store.js";

export type PathEntry = Exclude<FileEntry, { type: "session" }>;

/** pi JSONL에서 leaf까지 이어지는 엔트리를 시간순으로 돌려준다 (실패해서 버린 턴과 다른 분기는 빠진다). leafId가 null이면 마지막 엔트리까지. */
export function readPath(sessionFile: string, leafId: string | null): PathEntry[] {
  const entries = parseSessionEntries(readFileSync(sessionFile, "utf8")).filter((e): e is PathEntry => e.type !== "session");
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: PathEntry[] = [];
  let current = byId.get(leafId ?? entries.at(-1)?.id ?? "");
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * 관리 화면 대화 기록: commit된 leaf까지의 메시지.
 * 이미지는 데이터를 빼고 자리만 남긴다.
 */
export function readTranscript(record: SessionRecord): unknown[] {
  if (record.turn === 0 || !record.sessionFile || !existsSync(record.sessionFile)) return [];
  return readPath(record.sessionFile, record.leafId).flatMap((e) => (e.type === "message" ? [withoutImageData(e.message)] : []));
}

function withoutImageData(message: object): object {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  return { ...message, content: content.map((c: { type?: string }) => (c.type === "image" ? { type: "image" } : c)) };
}
