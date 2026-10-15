import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UidAllocator } from "../src/upstream/connect.js";
import { processesOwnedBy, reapUid } from "../src/upstream/uid-reaper.js";
import { piClient, processAlive, startTestBroker, textOf } from "./helpers.js";

/** /proc 흉내: pid별 status 파일 */
function fakeProc(entries: { pid: number; uid: number; state?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
  for (const e of entries) {
    mkdirSync(join(root, String(e.pid)));
    writeFileSync(
      join(root, String(e.pid), "status"),
      `Name:\tx\nState:\t${e.state ?? "S"} (sleeping)\nPid:\t${e.pid}\nUid:\t${e.uid}\t${e.uid}\t${e.uid}\t${e.uid}\n`,
    );
  }
  mkdirSync(join(root, "self"));
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("uid reaper", () => {
  it("uid가 같은 살아 있는 프로세스만 찾는다 (좀비 제외)", async () => {
    const root = fakeProc([
      { pid: 10, uid: 20001 },
      { pid: 11, uid: 20001, state: "Z" },
      { pid: 12, uid: 20002 },
      { pid: 13, uid: 20001, state: "R" },
    ]);
    roots.push(root);
    expect((await processesOwnedBy(20001, root)).sort()).toEqual([10, 13]);
    expect(await processesOwnedBy(29999, root)).toEqual([]);
  });

  it("남은 프로세스를 SIGKILL하고 모두 사라지면 true", async () => {
    const root = fakeProc([
      { pid: 20, uid: 20005 },
      { pid: 21, uid: 20005 },
    ]);
    roots.push(root);
    const killed: number[] = [];
    const ok = await reapUid(20005, {
      procRoot: root,
      intervalMs: 5,
      kill: (pid, signal) => {
        expect(signal).toBe("SIGKILL");
        killed.push(pid);
        rmSync(join(root, String(pid)), { recursive: true, force: true });
      },
    });
    expect(ok).toBe(true);
    expect(killed.sort()).toEqual([20, 21]);
  });

  it("끝내 죽지 않는 프로세스가 있으면 false", async () => {
    const root = fakeProc([{ pid: 30, uid: 20006 }]);
    roots.push(root);
    const ok = await reapUid(20006, { procRoot: root, timeoutMs: 100, intervalMs: 10, kill: () => {} });
    expect(ok).toBe(false);
  });

  it("정리를 확인하지 못한 uid는 격리하고 다시 주지 않는다", async () => {
    let clean = false;
    const allocator = new UidAllocator({ start: 20000, end: 20002 }, async () => clean);
    const a = allocator.allocate();
    expect(await allocator.reclaim(a)).toBe(false);
    expect(allocator.quarantined).toBe(1);
    clean = true;
    const seen = new Set<number>();
    for (let i = 0; i < 2; i++) seen.add(allocator.allocate());
    expect(seen.has(a)).toBe(false);
    expect(() => allocator.allocate()).toThrow(/no free uid/);
  });

  it("uid는 범위를 한 바퀴 돈 뒤에야 다시 쓴다", async () => {
    const allocator = new UidAllocator({ start: 20000, end: 20002 }, async () => true);
    const first = allocator.allocate();
    await allocator.reclaim(first);
    expect(allocator.allocate()).not.toBe(first);
  });

  it("작업 디렉토리 정리는 uid를 돌려주기 전에 끝난다", async () => {
    const order: string[] = [];
    const allocator = new UidAllocator({ start: 20000, end: 20000 }, async () => {
      order.push("reap");
      return true;
    });
    const uid = allocator.allocate();
    const reclaiming = allocator.reclaim(uid, async () => {
      order.push("cleanup");
      expect(() => allocator.allocate()).toThrow();
    });
    await reclaiming;
    order.push("released");
    expect(allocator.allocate()).toBe(uid);
    expect(order).toEqual(["reap", "cleanup", "released"]);
  });
});

// root로 실행할 때만 (CAP_SETUID 필요): 실제 uid 범위로 setsid 탈출 프로세스까지 정리되는지 확인한다.
describe.skipIf(process.getuid?.() !== 0)("uid isolation (root only)", { timeout: 120_000 }, () => {
  it("연결을 닫으면 setsid로 빠져나간 자손까지 죽인다", async () => {
    const tb = await startTestBroker({
      stdio: {
        uidRange: { start: 23000, end: 23009 },
        path: "/usr/local/bin:/usr/bin:/bin",
        lang: "C.UTF-8",
        workRoot: mkdtempSync(join(tmpdir(), "mcp-broker-uid-")),
        maxMessageBytes: 16 * 1024 * 1024,
        commandAllowlist: [],
      },
    });
    try {
      await tb.addStdioServer("iso", { scope: "per-user" });
      const client = await piClient(tb, "iso", { sub: "alice", sid: "s1" });
      const who = JSON.parse(textOf(await client.callTool("whoami", {})));
      expect(who.uid).toBeGreaterThanOrEqual(23000);
      const { pid: escaped } = JSON.parse(textOf(await client.callTool("escape_group", {})));
      await client.close();
      tb.broker.pool.retireServer("iso");
      for (let i = 0; i < 100 && processAlive(escaped); i++) await new Promise((r) => setTimeout(r, 100));
      expect(processAlive(escaped)).toBe(false);
      expect(await processesOwnedBy(who.uid)).toEqual([]);
    } finally {
      await tb.close();
    }
  });
});
