import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("keep");
  });
});
