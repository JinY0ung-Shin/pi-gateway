import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOXD_ROUTES } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolPolicy } from "../src/contracts.js";
import { bombPng, tinyPng } from "./fixtures/images.js";
import { type Harness, last, ofType, startHarness } from "./helpers.js";

// 가짜 sandbox가 실행할 최소 ripgrep (실제 sandbox 이미지에는 진짜 rg가 있다)
function installFakeRg(): () => void {
  const bin = mkdtempSync(join(tmpdir(), "fake-rg-bin-"));
  const script = fileURLToPath(new URL("./fixtures/fake-rg.mjs", import.meta.url));
  writeFileSync(join(bin, "rg"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(bin, "rg"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  return () => {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  };
}

let uninstallFakeRg: (() => void) | undefined;

let h: Harness;
const disabled = new Set<string>();
const policy: ToolPolicy = {
  isEnabled: (entry) => entry.required === true || !disabled.has(entry.name),
  revision: () => 0,
};

beforeAll(async () => {
  uninstallFakeRg = installFakeRg();
  h = await startHarness({ toolPolicy: policy });
});
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    uninstallFakeRg?.();
  }
});

const toolNames = (i: number) => (h.llm.requests[i]!.tools ?? []).map((t) => t.function.name).sort();

describe("sandbox tools", () => {
  it("bash runs in the sandbox with no gateway env and streams tool events", async () => {
    const tmpBefore = new Set(readdirSync(tmpdir()));
    h.llm.enqueue({ toolCalls: [{ id: "call_bash_1", name: "bash", arguments: { command: "echo hi-from-sandbox" } }] }, { text: "done" });
    const res = await h.stream({ input: "run it" });
    const types = res.events.map((e) => e.type);
    expect(types).toContain("response.tool_use_started");
    const toolUse = ofType(res.events, "response.tool_use")[0]!.data;
    expect(toolUse).toMatchObject({ tool_use_id: "call_bash_1", name: "bash", input: { command: "echo hi-from-sandbox" } });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result).toMatchObject({ tool_use_id: "call_bash_1", is_error: false });
    expect(String(result.content)).toContain("hi-from-sandbox");
    expect(last(res.events).type).toBe("response.completed");

    const exec = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.exec && JSON.stringify(c.body.argv).includes("hi-from-sandbox"))!;
    expect(exec.user).toBe("alice");
    expect(exec.body.argv).toEqual(["bash", "-c", "echo hi-from-sandbox"]);
    expect(exec.body.cwd).toBe("/workspace");
    // gateway의 환경변수는 하나도 넘기지 않는다
    expect(exec.body.env).toEqual({});
    expect(h.sandbox.authFailures).toEqual([]);
    // gateway 로컬 tmp에 pi-bash 출력 파일을 만들지 않는다
    const created = readdirSync(tmpdir()).filter((f) => !tmpBefore.has(f) && f.startsWith("pi-bash"));
    expect(created).toEqual([]);
  });

  it("non-zero exit codes are reported as tool errors", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_fail", name: "bash", arguments: { command: "echo nope; exit 3" } }] }, { text: "ok" });
    const res = await h.stream({ input: "fail" });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("Command exited with code 3");
  });

  it("long bash output is truncated and the full log is saved inside the sandbox", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "call_long", name: "bash", arguments: { command: "seq 1 5000" } }] }, { text: "ok" });
    const res = await h.stream({ input: "long" });
    const content = String(ofType(res.events, "response.tool_result")[0]!.data.content);
    expect(content).toContain("Full output: /tmp/pi-bash-call_long.log");
    const write = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.fsWrite && c.body.path === "/tmp/pi-bash-call_long.log");
    expect(write).toBeDefined();
  });

  it("write, read and edit operate on the sandbox workspace, never the gateway filesystem", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "w1", name: "write", arguments: { path: "notes/todo.txt", content: "alpha\nbeta\n" } }] },
      { toolCalls: [{ id: "e1", name: "edit", arguments: { path: "notes/todo.txt", edits: [{ oldText: "beta", newText: "gamma" }] } }] },
      { toolCalls: [{ id: "r1", name: "read", arguments: { path: "notes/todo.txt" } }] },
      { text: "done" },
    );
    const res = await h.stream({ input: "files" });
    const results = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(results.map((r) => r.is_error)).toEqual([false, false, false]);
    expect(String(results[2]!.content)).toContain("gamma");
    const onDisk = readFileSync(join(h.sandbox.workspaceOf("alice"), "notes/todo.txt"), "utf8");
    expect(onDisk).toBe("alpha\ngamma\n");
    expect(existsSync("/workspace/notes/todo.txt")).toBe(false);
  });

  it("ls and find use the sandbox listing and glob", async () => {
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "a.md"), "x");
    h.llm.enqueue(
      { toolCalls: [{ id: "ls1", name: "ls", arguments: { path: "." } }] },
      { toolCalls: [{ id: "f1", name: "find", arguments: { pattern: "*.md" } }] },
      { text: "done" },
    );
    const res = await h.stream({ input: "list" });
    const results = ofType(res.events, "response.tool_result").map((e) => String(e.data.content));
    expect(results[0]).toContain("a.md");
    expect(results[0]).toContain("notes/");
    expect(results[1]).toContain("a.md");
    expect(h.sandbox.calls.some((c) => c.route === SANDBOXD_ROUTES.fsGlob)).toBe(true);
  });

  it("read refuses decompression-bomb images without decoding them, and still reads normal images", async () => {
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "bomb.png"), bombPng());
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "small.png"), tinyPng());
    h.llm.enqueue(
      { toolCalls: [{ id: "rb", name: "read", arguments: { path: "bomb.png" } }] },
      { toolCalls: [{ id: "rs", name: "read", arguments: { path: "small.png" } }] },
      { text: "done" },
    );
    const before = process.memoryUsage().rss;
    const res = await h.stream({ input: "images" });
    const [bomb, small] = ofType(res.events, "response.tool_result").map((e) => String(e.data.content));
    expect(bomb).toContain("Image omitted (/workspace/bomb.png)");
    expect(bomb).toContain("20000x20000");
    expect(small).toContain("Read image file [image/png]");
    expect(last(res.events).type).toBe("response.completed");
    // 20000×20000 RGB를 디코딩했다면 1GB 넘게 늘어난다
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024);
  });

  it("~ paths map to the sandbox HOME", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "w2", name: "write", arguments: { path: "~/.config/x.txt", content: "home" } }] }, { text: "done" });
    await h.stream({ input: "home" });
    const write = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.fsWrite && String(c.body.path).endsWith("x.txt"))!;
    expect(write.body.path).toBe("/workspace/.home/.config/x.txt");
  });

  it("grep runs ripgrep inside the sandbox and formats matches and context like pi", async () => {
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "code.txt"), "one\nneedle here\nthree\n");
    h.llm.enqueue(
      { toolCalls: [{ id: "g1", name: "grep", arguments: { pattern: "needle", glob: "*.txt" } }] },
      { toolCalls: [{ id: "g2", name: "grep", arguments: { pattern: "NEEDLE", ignoreCase: true, context: 1, path: "code.txt" } }] },
      { toolCalls: [{ id: "g3", name: "grep", arguments: { pattern: "absent-xyz" } }] },
      { text: "done" },
    );
    const res = await h.stream({ input: "grep" });
    const [plain, withContext, none] = ofType(res.events, "response.tool_result").map((e) => String(e.data.content));
    expect(plain).toContain("code.txt:2: needle here");
    expect(withContext).toBe("code.txt-1- one\ncode.txt:2: needle here\ncode.txt-3- three");
    expect(none).toBe("No matches found");
    const exec = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.exec && (c.body.argv as string[])[0] === "rg")!;
    expect(exec.body.argv).toEqual(["rg", "--json", "--line-number", "--color=never", "--hidden", "--glob", "*.txt", "--", "needle", "/workspace"]);
  });

  it("sandbox paths outside the workspace come back as tool errors from the sandbox", async () => {
    h.llm.enqueue({ toolCalls: [{ id: "r2", name: "read", arguments: { path: "/etc/hostname" } }] }, { text: "done" });
    const res = await h.stream({ input: "etc" });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    // 가짜 sandbox는 /workspace, /tmp 밖을 거부한다 (실제 sandbox는 컨테이너 자신의 /etc를 보여준다)
    expect(result.is_error).toBe(true);
    const read = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.fsRead && c.body.path === "/etc/hostname");
    expect(read).toBeDefined();
  });
});

describe("tool policy", () => {
  it("declares the default tools to the model", async () => {
    const before = h.llm.requests.length;
    await h.post({ input: "tools?" });
    expect(toolNames(before)).toEqual(["AskUserQuestion", "bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  it("disabled tools are not offered; required tools (read) cannot be disabled", async () => {
    disabled.add("bash");
    disabled.add("read");
    try {
      const before = h.llm.requests.length;
      await h.post({ input: "tools?" });
      const names = toolNames(before);
      expect(names).not.toContain("bash");
      expect(names).toContain("read");
    } finally {
      disabled.clear();
    }
  });

  it("the tool catalog lists every provider", async () => {
    const catalog = await h.gateway.tools.list();
    const byName = new Map(catalog.map((e) => [e.name, e]));
    expect(byName.get("read")).toMatchObject({ provider: "sandbox", runsIn: "sandbox", required: true });
    expect(byName.get("bash")).toMatchObject({ provider: "sandbox", runsIn: "sandbox" });
    expect(byName.get("AskUserQuestion")).toMatchObject({ provider: "ask-user", runsIn: "gateway" });
  });
});
