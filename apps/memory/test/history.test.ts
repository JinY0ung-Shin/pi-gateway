import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiError, WikiStore } from "../src/wiki.js";

let dataDir: string;
let store: WikiStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-history-test-"));
  store = new WikiStore(dataDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const ownerRoot = (owner: string) => join(dataDir, "wikis", userKey(owner));
const git = (owner: string, ...args: string[]) => execFileSync("git", [`--git-dir=${join(ownerRoot(owner), ".git")}`, ...args], { encoding: "utf8" }).trimEnd();
/** 커밋 제목을 오래된 것부터 */
const subjects = (owner: string) => git(owner, "log", "--reverse", "--format=%s").split("\n");

describe("wiki 이력 (로컬 git)", () => {
  it("바뀔 때마다 커밋 하나를 남기고, 주인을 적고, 이전 내용을 되찾을 수 있다", async () => {
    const created = await store.write("alice", "wiki/배포.md", "one");
    const replaced = await store.write("alice", "wiki/배포.md", "two words", created.hash);
    const edited = await store.edit("alice", "wiki/배포.md", "two", "three", replaced.hash);
    await store.delete("alice", "wiki/배포.md", edited.hash);
    expect(subjects("alice")).toEqual(["create wiki/배포.md", "replace wiki/배포.md", "edit wiki/배포.md", "delete wiki/배포.md"]);
    expect(git("alice", "log", "-1", "--format=%an")).toBe("alice");
    expect(git("alice", "show", "HEAD~1:wiki/배포.md")).toBe("three words");
    expect(git("alice", "show", "HEAD~3:wiki/배포.md")).toBe("one");
    // 밖으로 보내는 곳이 없고, 커밋하지 않은 것이 남지 않는다.
    expect(git("alice", "remote")).toBe("");
    expect(git("alice", `--work-tree=${ownerRoot("alice")}`, "status", "--porcelain")).toBe("");
  });

  it("이력이 생기기 전에 있던 노트는 첫 변경 전에 따로 커밋한다", async () => {
    mkdirSync(join(ownerRoot("alice"), "wiki"), { recursive: true });
    writeFileSync(join(ownerRoot("alice"), "wiki", "old.md"), "before");
    const old = await store.readWhole("alice", "wiki/old.md");
    await store.write("alice", "wiki/old.md", "after", old.hash);
    expect(subjects("alice")).toEqual(["notes from before history began", "replace wiki/old.md"]);
    expect(git("alice", "show", "HEAD~1:wiki/old.md")).toBe("before");
  });

  it("내용이 같은 쓰기는 커밋을 남기지 않는다", async () => {
    const a = await store.write("alice", "a.md", "same");
    await store.write("alice", "a.md", "same", a.hash);
    expect(subjects("alice")).toEqual(["create a.md"]);
  });

  it("저장소는 목록·검색·사용량에 들지 않는다", async () => {
    await store.write("alice", "a.md", "needle");
    expect(await store.list("alice")).toEqual([{ path: "a.md", bytes: 6 }]);
    expect((await store.search("alice", "needle")).hits.map((h) => h.path)).toEqual(["a.md"]);
    expect(await store.wikis()).toEqual([{ key: userKey("alice"), owner: "alice", notes: 1, bytes: 6 }]);
  });

  it("wiki를 지우면 이력도 지워지고, 다음 쓰기가 새로 시작한다", async () => {
    await store.write("alice", "a.md", "x");
    await store.deleteAll("alice");
    expect(existsSync(ownerRoot("alice"))).toBe(false);
    await store.write("alice", "b.md", "y");
    expect(subjects("alice")).toEqual(["create b.md"]);
  });

  it("커밋하지 못하고 남은 변경은 서비스를 다시 띄운 뒤 첫 변경 전에 따로 남긴다", async () => {
    await store.write("alice", "a.md", "x");
    writeFileSync(join(ownerRoot("alice"), "a.md"), "saved but not recorded");
    await new WikiStore(dataDir).write("alice", "b.md", "y");
    expect(subjects("alice")).toEqual(["create a.md", "changes saved without a history entry", "create b.md"]);
    expect(git("alice", "show", "HEAD~1:a.md")).toBe("saved but not recorded");
  });

  it("이력을 남기지 못한 변경은 실패로 답한다 (거절이 아니라 저장소 실패다)", async () => {
    await store.write("alice", "a.md", "x");
    writeFileSync(join(ownerRoot("alice"), ".git", "HEAD"), "not a ref");
    const failed = await new WikiStore(dataDir).write("alice", "b.md", "y").then(
      () => null,
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WikiError);
    expect(await store.list("alice")).toEqual([{ path: "a.md", bytes: 1 }]);
  });
});
