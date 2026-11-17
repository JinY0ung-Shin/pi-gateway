import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter, SCAN_CAP } from "../src/search.js";
import { MAX_NOTE_BYTES, normalizeNotePath, READ_PAGE_BYTES, WikiError, WikiStore } from "../src/wiki.js";

let dataDir: string;
let store: WikiStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-test-"));
  store = new WikiStore(dataDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ownerRoot = (owner: string) => join(dataDir, "wikis", userKey(owner));
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (err) => (err instanceof WikiError ? err.code : `unexpected: ${err}`),
  );

describe("노트 경로", () => {
  it("앞의 /와 ./를 떼고, .md로 끝나는 상대 경로만 받는다", () => {
    expect(normalizeNotePath("/wiki/./deploy.md")).toBe("wiki/deploy.md");
    expect(normalizeNotePath("개념/배포.md")).toBe("개념/배포.md");
    for (const bad of ["", "wiki", "wiki/a.txt", "../a.md", "wiki/../../a.md", ".hidden/a.md", "wiki/.a.md", "a\\b.md", "a\nb.md", ".md"]) {
      expect(() => normalizeNotePath(bad), bad).toThrow(WikiError);
    }
  });

  it("폴더 자리의 노트, 노트 자리의 폴더, 링크는 거절한다", async () => {
    await store.write("alice", "a.md", "x");
    expect(await code(store.write("alice", "a.md/b.md", "x"))).toBe("invalid_path");
    await store.write("alice", "dir/b.md", "x");
    mkdirSync(join(ownerRoot("alice"), "folder.md"));
    expect(await code(store.read("alice", "folder.md"))).toBe("invalid_path");

    // 운영자가 볼륨에 링크를 놓아도 따라가지 않는다.
    const outside = join(dataDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(outside, join(ownerRoot("alice"), "link"));
    symlinkSync(join(outside, "secret.md"), join(ownerRoot("alice"), "linked.md"));
    expect(await code(store.read("alice", "link/secret.md"))).toBe("invalid_path");
    expect(await code(store.read("alice", "linked.md"))).toBe("invalid_path");
    expect(await code(store.write("alice", "link/new.md", "x"))).toBe("invalid_path");
    expect((await store.list("alice")).map((n) => n.path)).toEqual(["a.md", "dir/b.md"]);
  });
});

describe("쓰기와 hash", () => {
  it("새 노트를 만들고, 다시 읽으면 같은 내용과 hash가 나온다", async () => {
    const saved = await store.write("alice", "wiki/deploy.md", "# 배포\n금요일에는 하지 않는다");
    expect(saved.created).toBe(true);
    const note = await store.read("alice", "wiki/deploy.md");
    expect(note.content).toBe("# 배포\n금요일에는 하지 않는다");
    expect(note.hash).toBe(saved.hash);
    expect(await code(store.read("alice", "wiki/none.md"))).toBe("not_found");
  });

  it("있는 노트는 hash 없이 덮어쓰지 못하고, 그 사이 바뀐 노트는 거절한다", async () => {
    const first = await store.write("alice", "a.md", "one");
    expect(await code(store.write("alice", "a.md", "two"))).toBe("exists");
    const second = await store.write("alice", "a.md", "two", first.hash);
    expect(second.created).toBe(false);
    // 옛 hash로는 더 바꿀 수 없다.
    expect(await code(store.write("alice", "a.md", "three", first.hash))).toBe("stale");
    expect(await code(store.edit("alice", "a.md", "two", "three", first.hash))).toBe("stale");
    expect(await code(store.delete("alice", "a.md", first.hash))).toBe("stale");
    expect((await store.read("alice", "a.md")).content).toBe("two");
    // 지워진 노트를 hash로 바꾸려 해도 거절한다.
    await store.delete("alice", "a.md", second.hash);
    expect(await code(store.write("alice", "a.md", "again", second.hash))).toBe("stale");
  });

  it("동시에 들어온 두 쓰기 중 하나만 받는다", async () => {
    const first = await store.write("alice", "a.md", "base");
    const results = await Promise.all([code(store.write("alice", "a.md", "left", first.hash)), code(store.write("alice", "a.md", "right", first.hash))]);
    expect(results.sort()).toEqual(["ok", "stale"]);
  });

  it("edit는 정확히 한 번 나오는 글만 바꾼다", async () => {
    const first = await store.write("alice", "a.md", "port 80, port 80, host $1");
    expect(await code(store.edit("alice", "a.md", "port 80", "port 81", first.hash))).toBe("ambiguous");
    expect(await code(store.edit("alice", "a.md", "port 99", "port 81", first.hash))).toBe("no_match");
    expect(await code(store.edit("alice", "a.md", "host", "host", first.hash))).toBe("no_change");
    // 바꿀 글의 $는 치환 기호로 읽지 않는다.
    const edited = await store.edit("alice", "a.md", "host $1", "host $& $$", first.hash);
    const note = await store.read("alice", "a.md");
    expect(note.content).toBe("port 80, port 80, host $& $$");
    expect(note.hash).toBe(edited.hash);
  });

  it("지우면 비게 된 폴더도 지운다", async () => {
    const a = await store.write("alice", "deep/er/a.md", "x");
    const b = await store.write("alice", "deep/b.md", "x");
    await store.delete("alice", "deep/er/a.md", a.hash);
    expect(readdirSync(join(ownerRoot("alice"), "deep"))).toEqual(["b.md"]);
    await store.delete("alice", "deep/b.md", b.hash);
    expect(readdirSync(ownerRoot("alice"))).toEqual([]);
  });

  it("노트 크기 한도(512KiB)까지 받고, 넘으면 거절한다", async () => {
    expect(MAX_NOTE_BYTES).toBeGreaterThanOrEqual(512 * 1024);
    expect((await store.write("alice", "big.md", "a".repeat(MAX_NOTE_BYTES))).created).toBe(true);
    expect(await code(store.write("alice", "bigger.md", "a".repeat(MAX_NOTE_BYTES + 1)))).toBe("too_large");
    expect(await code(store.write("alice", "nul.md", "a\0b"))).toBe("invalid_content");
  });
});

describe("wiki 한도", () => {
  it("노트 수 한도: 넘으면 거절하고, 지우면 다시 받고, 있는 노트를 바꾸는 것은 세지 않는다", async () => {
    const small = new WikiStore(dataDir, { maxNotes: 3, maxWikiBytes: 1000 });
    const a = await small.write("alice", "a.md", "1");
    await small.write("alice", "b.md", "2");
    await small.write("alice", "c.md", "3");
    expect(await code(small.write("alice", "d.md", "4"))).toBe("wiki_full");
    const replaced = await small.write("alice", "a.md", "one", a.hash);
    await small.delete("alice", "a.md", replaced.hash);
    expect((await small.write("alice", "d.md", "4")).created).toBe(true);
    // 다른 주인의 한도는 따로다.
    expect((await small.write("bob", "a.md", "1")).created).toBe(true);
  });

  it("전체 크기 한도: 바꿀 때는 이전 크기를 빼고 센다", async () => {
    const small = new WikiStore(dataDir, { maxNotes: 100, maxWikiBytes: 100 });
    const a = await small.write("alice", "a.md", "x".repeat(60));
    expect(await code(small.write("alice", "b.md", "x".repeat(41)))).toBe("wiki_full");
    const b = await small.write("alice", "b.md", "x".repeat(40));
    // 60 → 50으로 줄이는 것은 되고, 61로 늘리는 것은 안 된다.
    const shorter = await small.write("alice", "a.md", "x".repeat(50), a.hash);
    expect(await code(small.write("alice", "a.md", "x".repeat(61), shorter.hash))).toBe("wiki_full");
    expect(await code(small.edit("alice", "b.md", "x".repeat(40), "x".repeat(51), b.hash))).toBe("wiki_full");
    // 서비스를 다시 띄워도(세어 둔 값이 없어도) 디스크에서 다시 세어 같은 판단을 한다.
    const restarted = new WikiStore(dataDir, { maxNotes: 100, maxWikiBytes: 100 });
    expect(await code(restarted.write("alice", "c.md", "x".repeat(11)))).toBe("wiki_full");
    expect((await restarted.write("alice", "c.md", "x".repeat(10))).created).toBe(true);
  });
});

describe("긴 노트", () => {
  it("나눠 읽은 부분을 이으면 원래 노트이고, 줄 끝에서 끊고 글자를 쪼개지 않는다", async () => {
    // 한글(3바이트)과 긴 줄을 섞어 여러 쪽이 되게 한다.
    const lines = Array.from({ length: 4000 }, (_, i) => `- ${i} 배포는 금요일에 하지 않는다`);
    const content = `${lines.join("\n")}\n${"가".repeat(30_000)}`;
    const saved = await store.write("alice", "long.md", content);
    let offset: number | null = 0;
    let joined = "";
    let parts = 0;
    while (offset !== null) {
      const part = await store.read("alice", "long.md", offset);
      expect(part.hash).toBe(saved.hash);
      expect(Buffer.byteLength(part.content)).toBeLessThanOrEqual(READ_PAGE_BYTES);
      expect(part.content).not.toContain("\uFFFD");
      if (part.next !== null && parts === 0) expect(part.content.endsWith("\n")).toBe(true);
      joined += part.content;
      offset = part.next;
      parts++;
    }
    expect(parts).toBeGreaterThan(3);
    expect(joined).toBe(content);
    expect(await code(store.read("alice", "long.md", Buffer.byteLength(content) + 1))).toBe("invalid_offset");
    // 글자 중간을 가리키는 offset은 받지 않는다.
    await store.write("alice", "ko.md", "가나다");
    expect(await code(store.read("alice", "ko.md", 1))).toBe("invalid_offset");
    expect((await store.read("alice", "ko.md", 3)).content).toBe("나다");
  });

  it("한 번에 다 읽히지 않는 노트는 write로 통째로 바꿀 수 없고, edit와 delete는 된다", async () => {
    const content = `head\n${"x".repeat(READ_PAGE_BYTES)}\ntail`;
    const saved = await store.write("alice", "long.md", content);
    // 앞부분만 보고 다시 쓰면 뒷부분이 사라진다: hash가 맞아도 거절한다.
    expect(await code(store.write("alice", "long.md", "head\nrewritten", saved.hash))).toBe("too_large");
    const edited = await store.edit("alice", "long.md", "tail", "TAIL", saved.hash);
    let last = await store.read("alice", "long.md");
    while (last.next !== null) last = await store.read("alice", "long.md", last.next);
    expect(last.content.endsWith("TAIL")).toBe(true);
    await store.delete("alice", "long.md", edited.hash);
    expect(await store.list("alice")).toEqual([]);
    // 한 번에 읽히는 크기까지는 통째로 바꿀 수 있다.
    const small = await store.write("alice", "small.md", "y".repeat(READ_PAGE_BYTES));
    expect((await store.write("alice", "small.md", "z", small.hash)).created).toBe(false);
  });
});

describe("주인", () => {
  it("주인마다 wiki가 따로다", async () => {
    await store.write("alice", "a.md", "alice only");
    expect(await store.list("bob")).toEqual([]);
    expect(await code(store.read("bob", "a.md"))).toBe("not_found");
    expect((await store.search("bob", "alice")).hits).toEqual([]);
    await store.write("bob", "a.md", "bob only");
    expect((await store.read("alice", "a.md")).content).toBe("alice only");
  });
});

describe("목록과 검색", () => {
  it("목록은 경로 순이고 폴더로 좁힐 수 있다", async () => {
    for (const path of ["wiki/b.md", "raw/2026-01-01-x.md", "wiki/a.md", "wikipedia.md"]) await store.write("alice", path, "x");
    expect((await store.list("alice")).map((n) => n.path)).toEqual(["raw/2026-01-01-x.md", "wiki/a.md", "wiki/b.md", "wikipedia.md"]);
    expect((await store.list("alice", "wiki/")).map((n) => n.path)).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(await code(store.list("alice", "../"))).toBe("invalid_path");
  });

  it("제목·별칭 > 태그 > 본문 순으로 순위를 매긴다", async () => {
    await store.write("alice", "body.md", "we talked about deploy once");
    await store.write("alice", "tag.md", "---\ntitle: Release notes\ntags: [deploy, ops]\n---\nnothing else");
    await store.write("alice", "title.md", "---\ntitle: Deploy checklist\naliases:\n  - rollout\n---\nsteps");
    await store.write("alice", "none.md", "unrelated");
    const { hits, unscanned } = await store.search("alice", "deploy");
    expect(hits.map((h) => h.path)).toEqual(["title.md", "tag.md", "body.md"]);
    expect(hits[1]!.tags).toEqual(["deploy", "ops"]);
    expect(hits[2]!.snippet).toContain("talked about deploy");
    expect(unscanned).toBe(0);
    expect((await store.search("alice", "rollout")).hits.map((h) => h.path)).toEqual(["title.md"]);
    expect((await store.search("alice", "deploy", 1)).hits).toHaveLength(1);
    expect((await store.search("alice", "deploy", undefined, "none")).hits).toEqual([]);
  });

  it("한 번에 읽는 수를 넘는 wiki는 읽지 않은 노트 수를 알린다", async () => {
    // 저장소를 거치면 쓸 때마다 전체를 세므로, 파일을 직접 놓는다.
    const root = join(ownerRoot("alice"), "n");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < SCAN_CAP + 3; i++) writeFileSync(join(root, `${String(i).padStart(5, "0")}.md`), i === SCAN_CAP + 1 ? "needle" : "hay");
    const result = await store.search("alice", "needle");
    expect(result.hits).toEqual([]);
    expect(result.unscanned).toBe(3);
  });

  it("목록·검색 도중 노트가 지워져도 실패하지 않는다", async () => {
    const saved = await Promise.all(Array.from({ length: 200 }, (_, i) => store.write("alice", `n/${i}.md`, "needle")));
    const deletes = saved.map((s) => store.delete("alice", s.path, s.hash));
    const reads = Array.from({ length: 20 }, (_, i) => (i % 2 ? store.list("alice") : store.search("alice", "needle")));
    await Promise.all([...deletes, ...reads]);
    expect(await store.list("alice")).toEqual([]);
  });

  it("낱말이 없는 검색어는 빈 결과가 아니라 거절이다", async () => {
    expect(await code(store.search("alice", "   "))).toBe("invalid_query");
  });

  it("frontmatter의 list는 주석 줄에서 끊기지 않고, 다른 key가 나오면 끝난다", () => {
    expect(parseFrontmatter("---\ntags:\n  # 메모\n  - a\n---\n").fm.tags).toEqual(["a"]);
    expect(parseFrontmatter("---\ntags:\n  - a\nrelated-notes:\n  - b\n---\n").fm.tags).toEqual(["a"]);
  });

  it("frontmatter가 없거나 깨져 있어도 본문으로 찾는다", () => {
    expect(parseFrontmatter("plain text").fm).toEqual({ title: "", tags: [], aliases: [] });
    expect(parseFrontmatter("---\ntitle: never closed\n").body).toBe("---\ntitle: never closed\n");
    expect(parseFrontmatter('---\ntitle: "Quoted"\ntags: one\n---\nbody').fm).toEqual({ title: "Quoted", tags: ["one"], aliases: [] });
  });
});
