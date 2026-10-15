import { randomBytes } from "node:crypto";
import fs, { readdirSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, ofType, startHarness } from "./helpers.js";

/**
 * pi의 read/write/edit이 agent가 준 경로로 gateway 로컬 파일시스템을 만지지 않는지 확인한다.
 * node:fs·node:fs/promises 함수를 감싸서 MARKER가 들어간 경로로 불린 로컬 호출을 모두 기록한다.
 * (ESM의 named import는 syncBuiltinESMExports()로 감싼 함수를 보게 된다.)
 */

const MARKER = `marker-${randomBytes(4).toString("hex")}`;
const seen: string[] = [];
const restorers: (() => void)[] = [];

function spy(target: Record<string, unknown>, names: string[]): void {
  for (const name of names) {
    const original = target[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, path: unknown, ...rest: unknown[]) {
      const p = typeof path === "string" ? path : path instanceof URL ? path.pathname : Buffer.isBuffer(path) ? path.toString() : "";
      if (p.includes(MARKER)) seen.push(`${name}:${p}`);
      return original.call(this, path, ...rest);
    };
    Object.assign(wrapped, original);
    target[name] = wrapped;
    restorers.push(() => {
      target[name] = original;
    });
  }
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  spy(fsp as unknown as Record<string, unknown>, ["access", "realpath", "stat", "lstat", "readFile", "writeFile", "open", "mkdir", "readdir", "rm"]);
  spy(fs as unknown as Record<string, unknown>, [
    "accessSync", "existsSync", "realpathSync", "statSync", "lstatSync", "readFileSync", "writeFileSync", "openSync", "mkdirSync", "readdirSync",
    "access", "realpath", "stat", "lstat", "readFile", "writeFile", "open",
  ]);
  syncBuiltinESMExports();
});
afterAll(async () => {
  for (const r of restorers) r();
  syncBuiltinESMExports();
  await h.close();
});

describe("no gateway-local filesystem access for agent paths", () => {
  it("control: pi's own tools would touch local paths (so the spy works)", async () => {
    const before = seen.length;
    const ops = { writeFile: async () => {}, mkdir: async () => {} };
    const write = createWriteToolDefinition("/workspace", { operations: ops });
    await write.execute("ctl1", { path: `/workspace/${MARKER}-ctl.txt`, content: "x" }, undefined, undefined, { cwd: "/workspace" } as never);
    const readOps = { readFile: async () => Buffer.from("x"), access: async () => {} };
    const read = createReadToolDefinition("/workspace", { operations: readOps });
    await read.execute("ctl2", { path: `/workspace/${MARKER}-ctl.txt` }, undefined, undefined, { cwd: "/workspace" } as never);
    const local = seen.slice(before);
    expect(local.some((c) => c.startsWith("realpath:/workspace/"))).toBe(true);
    expect(local.some((c) => c.includes("/workspace/") && !c.includes("/.pi-sbx/"))).toBe(true);
  });

  it("gateway read/write/edit only ever hand pi namespaced paths that cannot exist locally", async () => {
    const before = seen.length;
    h.llm.enqueue(
      { toolCalls: [{ id: "w1", name: "write", arguments: { path: `${MARKER}.txt`, content: "alpha\n" } }] },
      { toolCalls: [{ id: "e1", name: "edit", arguments: { path: `/workspace/${MARKER}.txt`, edits: [{ oldText: "alpha", newText: "beta" }] } }] },
      { toolCalls: [{ id: "r1", name: "read", arguments: { path: `${MARKER}.txt` } }] },
      // 로컬에 실제로 있는 경로 (/tmp)로도 확인한다
      { toolCalls: [{ id: "r2", name: "read", arguments: { path: `/tmp/${MARKER}-missing` } }] },
      { text: "done" },
    );
    const res = await h.stream({ input: "files" });
    const results = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(results.slice(0, 3).map((r) => r.is_error)).toEqual([false, false, false]);
    expect(String(results[2]!.content)).toContain("beta");
    // 결과 텍스트에는 sandbox 경로만 보인다
    const all = JSON.stringify(results);
    expect(all).not.toContain(".pi-sbx");
    expect(String(results[0]!.content)).toContain(`/workspace/${MARKER}.txt`);
    expect(String(results[3]!.content)).toContain(`/tmp/${MARKER}-missing`);
    // pi의 로컬 호출은 모두 gateway에 존재할 수 없는 이름공간 경로였다.
    // (가짜 sandboxd는 이 테스트 프로세스 안에서 자기 임시 디렉토리를 쓰므로 그 호출은 뺀다)
    const local = seen.slice(before).filter((c) => !c.includes(h.sandbox.root));
    expect(local.length).toBeGreaterThan(0);
    expect(local.filter((c) => !c.includes(":/.pi-sbx/"))).toEqual([]);
  });

  it("each session gets its own namespace (no shared mutation queue keys across sessions)", async () => {
    const before = seen.length;
    h.llm.enqueue({ toolCalls: [{ id: "w2", name: "write", arguments: { path: `${MARKER}-s.txt`, content: "1" } }] }, { text: "ok" });
    await h.post({ input: "session one" });
    h.llm.enqueue({ toolCalls: [{ id: "w3", name: "write", arguments: { path: `${MARKER}-s.txt`, content: "2" } }] }, { text: "ok" });
    await h.post({ input: "session two" });
    const prefixes = new Set(
      seen
        .slice(before)
        .filter((c) => !c.includes(h.sandbox.root))
        .map((c) => /:(\/\.pi-sbx\/[0-9a-f]+)\//.exec(c)?.[1])
        .filter(Boolean),
    );
    expect(prefixes.size).toBe(2);
  });
});

describe("the path namespace never leaks", () => {
  it("not in SSE, model-bound messages or the session JSONL — including argument validation errors", async () => {
    h.llm.enqueue(
      // 검증 실패: content 없음, offset 타입 오류
      { toolCalls: [{ id: "bad_w", name: "write", arguments: { path: "/tmp/t.txt" } }] },
      { toolCalls: [{ id: "bad_r", name: "read", arguments: { path: "notes/a.txt", offset: "abc" } }] },
      { toolCalls: [{ id: "bad_e", name: "edit", arguments: { path: "notes/a.txt" } }] },
      // 실행 오류
      { toolCalls: [{ id: "miss", name: "read", arguments: { path: "missing/file.txt" } }] },
      { toolCalls: [{ id: "ok_w", name: "write", arguments: { path: "notes/a.txt", content: "alpha\n" } }] },
      { toolCalls: [{ id: "bad_edit", name: "edit", arguments: { path: "notes/a.txt", edits: [{ oldText: "NOPE", newText: "x" }] } }] },
      { text: "done" },
    );
    const before = h.llm.requests.length;
    const res = await h.stream({ input: "invalid calls" });
    const results = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(results.find((r) => r.tool_use_id === "bad_w")!.is_error).toBe(true);
    expect(results.find((r) => r.tool_use_id === "bad_r")!.is_error).toBe(true);
    expect(String(results.find((r) => r.tool_use_id === "bad_w")!.content)).toContain("/tmp/t.txt");
    expect(res.raw).not.toContain(".pi-sbx");
    expect(JSON.stringify(h.llm.requests.slice(before))).not.toContain(".pi-sbx");
    const sessions = join(h.config.dataDir, "sessions");
    let jsonl = "";
    for (const d of readdirSync(sessions)) for (const f of readdirSync(join(sessions, d))) jsonl += readFileSync(join(sessions, d, f), "utf8");
    expect(jsonl.length).toBeGreaterThan(0);
    expect(jsonl).not.toContain(".pi-sbx");
  });
});
