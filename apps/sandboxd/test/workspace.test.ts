import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";
import { tempDir } from "./helpers.js";
import { rmSync } from "node:fs";

const dirs: string[] = [];
const fresh = (p: string) => {
  const d = tempDir(p);
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // 무시
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("Workspaces", () => {
  it("workspace와 .home을 0700으로 만든다", async () => {
    const root = fresh("ws-root-");
    const ws = new Workspaces(root);
    const key = userKey("alice");
    const dir = await ws.ensure(key);
    expect(dir).toBe(join(root, key));
    expect(existsSync(join(dir, ".home"))).toBe(true);
    await ws.ensure(key); // 두 번 불러도 괜찮다
  });

  it("key 형식이 아니면 거부한다", async () => {
    const ws = new Workspaces(fresh("ws-root-"));
    await expect(ws.ensure("../../etc")).rejects.toThrow();
    expect(() => ws.dir("u-../x")).toThrow();
  });

  it("최상위 workspace가 링크면 따라가지 않고 거부한다", async () => {
    const root = fresh("ws-root-");
    const outside = fresh("ws-outside-");
    writeFileSync(join(outside, "precious"), "keep");
    const key = userKey("mallory");
    symlinkSync(outside, join(root, key));
    const ws = new Workspaces(root);
    await expect(ws.ensure(key)).rejects.toThrow();
    await expect(ws.remove(key)).rejects.toThrow();
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
  });

  it("삭제할 때 안쪽 링크를 따라가지 않고, 막아 둔 디렉토리도 지운다", async () => {
    const root = fresh("ws-root-");
    const outside = fresh("ws-outside-");
    writeFileSync(join(outside, "precious"), "keep");
    const ws = new Workspaces(root);
    const key = userKey("alice");
    const dir = await ws.ensure(key);
    symlinkSync(outside, join(dir, "link-to-outside"));
    symlinkSync(join(outside, "precious"), join(dir, "link-to-file"));
    mkdirSync(join(dir, "locked", "inner"), { recursive: true });
    writeFileSync(join(dir, "locked", "inner", "f"), "x");
    chmodSync(join(dir, "locked", "inner"), 0o500);
    chmodSync(join(dir, "locked"), 0o000);
    await ws.remove(key);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
  });

  it("오래된 익명 workspace를 메타로 찾는다", async () => {
    const ws = new Workspaces(fresh("ws-root-"));
    const old = userKey("_anon-11111111-1111-1111-1111-111111111111");
    const recent = userKey("_anon-22222222-2222-2222-2222-222222222222");
    const named = userKey("alice");
    await ws.writeMeta(old, { anon: true, lastActive: 1000 });
    await ws.writeMeta(recent, { anon: true, lastActive: 9000 });
    await ws.writeMeta(named, { anon: false, lastActive: 1 });
    expect(await ws.staleAnon(5000)).toEqual([old]);
  });
});
