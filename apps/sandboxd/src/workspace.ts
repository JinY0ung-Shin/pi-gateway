import { lchown, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_GID, SANDBOX_UID } from "@pi-gateway/shared";
import { SandboxError } from "./errors.js";
import { USER_KEY_PATTERN } from "./spec.js";

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
}
