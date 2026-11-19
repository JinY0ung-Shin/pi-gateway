import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterAll, beforeAll, test } from "vitest";
import { SCAN_CAP } from "../src/search.js";
import { MAX_NOTE_BYTES, WikiStore } from "../src/wiki.js";

/**
 * 검색 한 번에 걸리는 시간. `npx vitest bench --reporter verbose`로만 돈다 (`npx vitest run`에는 들지 않는다).
 * 기본 reporter는 터미널이 아닌 곳(CI, pipe)에서 표를 찍지 않는다.
 * 숫자만 보여 주고 통과 기준은 없다: 돌린 머신의 속도이지 운영 서버의 속도가 아니다.
 */

const LARGE_NOTES = 10;
const SENTENCE = "배포 전에 결함이 있는지 확인하고 release checklist를 본다. ";
const QUERY = "결함을 배포 checklist";
/** 검색 한 번이 길어서 횟수로만 끊는다 (기본값은 64번과 1초를 모두 채운다). */
const RUN = { iterations: 10, time: 0, warmupIterations: 2, warmupTime: 0 };

let dataDir: string;
let store: WikiStore;

/** 저장소를 거치면 쓸 때마다 전체를 세므로, 파일을 직접 놓는다. */
function put(owner: string, count: number, bytes: number): void {
  const root = join(dataDir, "wikis", userKey(owner), "n");
  mkdirSync(root, { recursive: true });
  const body = SENTENCE.repeat(Math.floor(bytes / Buffer.byteLength(SENTENCE)));
  for (let i = 0; i < count; i++) writeFileSync(join(root, `${String(i).padStart(5, "0")}.md`), `---\ntitle: 노트 ${i}\ntags: [bench]\n---\n${body}`);
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-bench-"));
  store = new WikiStore(dataDir);
  put("small", SCAN_CAP, 1024);
  put("large", LARGE_NOTES, MAX_NOTE_BYTES - 1024);
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test("검색 한 번", async ({ bench }) => {
  await bench(`1KiB 노트 ${SCAN_CAP}개`, async () => void (await store.search("small", QUERY))).run(RUN);
  await bench(`${MAX_NOTE_BYTES / 1024}KiB 노트 ${LARGE_NOTES}개`, async () => void (await store.search("large", QUERY))).run(RUN);
});
