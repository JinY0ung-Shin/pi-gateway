import { existsSync, readFileSync } from "node:fs";
import { type FileEntry, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SessionRecord } from "./store.js";

/**
 * 관리 화면 대화 기록: pi JSONL에서 commit된 leaf까지의 메시지 (실패해서 버린 턴은 빠진다).
 * 이미지는 데이터를 빼고 자리만 남긴다.
 */
export function readTranscript(record: SessionRecord): unknown[] {
  if (record.turn === 0 || !record.sessionFile || !existsSync(record.sessionFile)) return [];
  const entries = parseSessionEntries(readFileSync(record.sessionFile, "utf8")).filter(
    (e): e is Exclude<FileEntry, { type: "session" }> => e.type !== "session",
  );
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path: unknown[] = [];
  let current = byId.get(record.leafId ?? entries.at(-1)?.id ?? "");
  while (current) {
    if (current.type === "message") path.push(withoutImageData(current.message));
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function withoutImageData(message: object): object {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return message;
  return { ...message, content: content.map((c: { type?: string }) => (c.type === "image" ? { type: "image" } : c)) };
}
