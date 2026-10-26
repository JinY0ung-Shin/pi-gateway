import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SandboxError } from "./errors.js";
import { USER_KEY_PATTERN } from "./spec.js";

/**
 * 호스트의 workspace 디렉토리 관리. `<root>/<userKey>`만 다룬다.
 * sandboxd는 sandbox와 같은 uid(1000)로 돌아서, 만든 디렉토리가 그대로 sandbox 사용자의 것이 된다.
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
    await mkdirIfMissing(dir);
    const st = await lstat(dir);
    if (!st.isDirectory()) throw new SandboxError("internal", "workspace path is not a directory");
    if ((await realpath(dir)) !== join(await this.rootReal(), key)) {
      throw new SandboxError("internal", "workspace path escapes the workspaces root");
    }
    // .home은 sandbox 안에서 agent가 바꿀 수 있으므로 만들기만 하고 따라가지 않는다
    await mkdirIfMissing(join(dir, ".home"));
    return dir;
  }
}

async function mkdirIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}
