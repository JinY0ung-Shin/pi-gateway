import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * uid 하나에 속한 프로세스를 모두 없앤다.
 *
 * stdio 서버를 process group째 죽여도, setsid로 새 세션을 만든 자손은 살아남는다.
 * 그 uid를 다음 서버에 다시 주면, 살아남은 프로세스가 새 서버의 /proc/<pid>/environ(비밀값)을 읽을 수 있다.
 * 그래서 uid를 돌려주기 전에 그 uid의 프로세스가 하나도 없다는 것을 /proc으로 확인한다.
 */

export interface ReapOptions {
  procRoot?: string;
  /** 직접 신호를 보내는 함수 (테스트에서 바꾼다) */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** uid로 `kill(-1, SIGKILL)`을 실행하는 함수. 없으면 직접 신호만 보낸다. */
  killAllAsUid?: (uid: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

/** real·effective·saved·fs uid 중 하나라도 uid와 같고, 이미 끝난(좀비) 프로세스가 아닌 pid 목록 */
export async function processesOwnedBy(uid: number, procRoot = "/proc"): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let status: string;
    try {
      status = await readFile(join(procRoot, name, "status"), "utf8");
    } catch {
      continue; // 그 사이에 끝난 프로세스
    }
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    const state = /^State:\s+(\S)/m.exec(status)?.[1];
    if (!uids || state === "Z" || state === "X") continue;
    if (uids.slice(1, 5).map(Number).includes(uid)) pids.push(Number(name));
  }
  return pids;
}

/** 해당 uid로 짧은 프로세스를 띄워 kill(-1, SIGKILL)을 부른다. 그 uid가 신호를 보낼 수 있는 모든 프로세스가 죽는다. */
export function killAllAsUid(uid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "try { process.kill(-1, 'SIGKILL') } catch {}"], {
      uid,
      gid: uid,
      env: {},
      cwd: "/",
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("error", done);
    child.once("exit", done);
  });
}

/** uid의 프로세스가 모두 사라질 때까지 죽인다. 정해진 시간 안에 비지 않으면 false. */
export async function reapUid(uid: number, options: ReapOptions = {}): Promise<boolean> {
  const procRoot = options.procRoot ?? "/proc";
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const interval = options.intervalMs ?? 50;
  for (;;) {
    const pids = await processesOwnedBy(uid, procRoot);
    if (pids.length === 0) return true;
    if (Date.now() > deadline) return false;
    if (options.killAllAsUid) await options.killAllAsUid(uid);
    for (const pid of pids) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // 이미 끝났다
      }
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
