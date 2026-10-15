import { chmod, lchown, lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_GID, SANDBOX_UID } from "@pi-gateway/shared";
import { SandboxError } from "./errors.js";
import { USER_KEY_PATTERN } from "./spec.js";

const META_DIR = ".meta";

export interface WorkspaceMeta {
  anon: boolean;
  lastActive: number;
}

/**
 * 호스트의 workspace 디렉토리 관리. `<root>/<userKey>`만 다룬다.
 * sandboxd는 sandbox와 같은 uid(1000)로 돌거나, root라면 만든 디렉토리를 1000으로 넘긴다.
 */
export class Workspaces {
  private realRoot: string | undefined;

  constructor(private readonly root: string) {}

  dir(key: string): string {
    if (!USER_KEY_PATTERN.test(key)) throw new SandboxError("invalid_request", "invalid user key");
    return join(this.root, key);
  }

  private async rootReal(): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    return this.realRoot;
  }

  /** 사용자 workspace와 그 안의 .home을 만든다. 이미 있으면 진짜 디렉토리인지 확인만 한다. */
  async ensure(key: string): Promise<string> {
    const dir = this.dir(key);
    await this.mkdirOwned(dir);
    const st = await lstat(dir);
    if (!st.isDirectory()) throw new SandboxError("internal", "workspace path is not a directory");
    if ((await realpath(dir)) !== join(await this.rootReal(), key)) {
      throw new SandboxError("internal", "workspace path escapes the workspaces root");
    }
    // .home은 sandbox 안에서 agent가 바꿀 수 있으므로 만들기만 하고 따라가지 않는다
    try {
      await mkdir(join(dir, ".home"), { mode: 0o700 });
      await this.giveToSandbox(join(dir, ".home"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return dir;
  }

  private async mkdirOwned(dir: string): Promise<void> {
    try {
      await mkdir(dir, { mode: 0o700 });
      await this.giveToSandbox(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  /**
   * root로 돌 때만 방금 만든 디렉토리를 sandbox uid에 넘긴다. lchown이라 그 사이에 링크로 바뀌어 있어도
   * 링크 자체만 바뀌고 대상(호스트 파일)은 건드리지 않는다. 기본 배포는 sandboxd를 uid 1000으로 돌려 이 경로를 쓰지 않는다.
   */
  private async giveToSandbox(path: string): Promise<void> {
    if (process.getuid?.() === 0) await lchown(path, SANDBOX_UID, SANDBOX_GID);
  }

  /**
   * workspace를 지운다. 링크는 따라가지 않고(링크 자체만 지운다) root 밖으로 나가지 않는다.
   * agent가 권한을 막아 둔 디렉토리도 소유자 권한으로 풀고 지운다.
   */
  async remove(key: string): Promise<void> {
    const dir = this.dir(key);
    let st;
    try {
      st = await lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!st.isDirectory()) throw new SandboxError("internal", "workspace path is not a directory");
    if ((await realpath(dir)) !== join(await this.rootReal(), key)) {
      throw new SandboxError("internal", "workspace path escapes the workspaces root");
    }
    await unlockTree(dir);
    await rm(dir, { recursive: true, force: true });
    await rm(this.metaPath(key), { force: true });
  }

  private metaPath(key: string): string {
    return join(this.root, META_DIR, `${key}.json`);
  }

  async writeMeta(key: string, meta: WorkspaceMeta): Promise<void> {
    await mkdir(join(this.root, META_DIR), { recursive: true, mode: 0o700 });
    await writeFile(this.metaPath(key), JSON.stringify(meta), { mode: 0o600 });
  }

  /** 익명 workspace 중 마지막 활동이 cutoff보다 오래된 것의 key */
  async staleAnon(cutoff: number): Promise<string[]> {
    const stale: string[] = [];
    let dir;
    try {
      dir = await opendir(join(this.root, META_DIR));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return stale;
      throw err;
    }
    for await (const entry of dir) {
      const key = entry.name.replace(/\.json$/, "");
      if (!entry.isFile() || !USER_KEY_PATTERN.test(key)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.root, META_DIR, entry.name), "utf8")) as WorkspaceMeta;
        if (meta.anon && meta.lastActive < cutoff) stale.push(key);
      } catch {
        // 깨진 메타는 무시한다
      }
    }
    return stale;
  }
}

/**
 * 트리 안의 디렉토리에 소유자 rwx를 다시 준다. 링크는 따라가지 않는다: lstat으로 링크가 아닌
 * 디렉토리일 때만 chmod한다. 삭제는 컨테이너를 지운 뒤 같은 사용자 lock 안에서만 하므로,
 * 그 사이에 트리를 바꿀 프로세스가 없다 (lstat과 chmod 사이의 경쟁이 생기지 않는다).
 */
async function unlockTree(dir: string): Promise<void> {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return;
    await chmod(dir, 0o700);
  } catch {
    return;
  }
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  for await (const entry of handle) {
    if (entry.isDirectory()) await unlockTree(join(dir, entry.name));
  }
}
