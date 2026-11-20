import { execFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * wiki의 변경 이력. wiki마다 로컬 git 저장소(`<wiki>/.git`)가 하나 있고, 바뀔 때마다 wiki 전체를 한 커밋으로 남긴다.
 * - 밖으로 보내지 않는다 (remote가 없다). 볼륨을 잃으면 이력도 함께 사라진다: 백업은 볼륨이 대상이다.
 * - 노트 경로는 점으로 시작하는 이름을 받지 않으므로 `.git`이나 `.gitattributes`를 노트로 만들 수 없다.
 *   hook, 시스템 설정, 사용자 설정은 쓰지 않는다.
 * - 이력을 남기지 못한 변경은 실패로 답한다 (노트는 이미 바뀌어 있을 수 있다). 그 변경은 다음 커밋에 함께 들어간다.
 */

/** 쓰다가 죽어 남은 임시 파일은 이력에 넣지 않는다 (wiki.ts의 TMP_NAME) */
const EXCLUDE = "/.*.tmp\n";

const CONFIG = [
  "core.hooksPath=/dev/null",
  "core.autocrlf=false",
  // 노트와 같은 수준으로 디스크에 내린다 (전원이 나가도 저장소가 깨지지 않게). batch: 커밋 하나의 object들을 한 번에 내린다
  // (이력이 생기기 전의 노트 수천 개를 처음 커밋할 때 하나씩 내리면 열 배쯤 걸린다).
  "core.fsync=all",
  "core.fsyncMethod=batch",
  // 정리(gc)는 이 호출 안에서 끝낸다. 주인의 lock 밖에서 저장소를 만지는 프로세스를 남기지 않는다.
  "gc.autoDetach=false",
  "maintenance.autoDetach=false",
].flatMap((c) => ["-c", c]);

/** git을 실행하고 종료 코드를 돌려준다. `ok`에 없는 코드는 실패다. */
function git(args: string[], options: { ok?: number[]; author?: string } = {}): Promise<number> {
  const who = options.author ?? "memory";
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/nonexistent",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: who,
    GIT_AUTHOR_EMAIL: "memory@pi-gateway.invalid",
    GIT_COMMITTER_NAME: who,
    GIT_COMMITTER_EMAIL: "memory@pi-gateway.invalid",
  };
  return new Promise((resolve, reject) => {
    execFile("git", [...CONFIG, ...args], { env, timeout: 600_000, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve(0);
      if (typeof err.code === "number" && options.ok?.includes(err.code)) return resolve(err.code);
      reject(new Error(`git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${stderr.trim() || err.message}`));
    });
  });
}

/** 시작할 때 git이 있는지 본다. 없으면 이력을 남길 수 없으므로 서비스를 띄우지 않는다. */
export async function assertGit(): Promise<void> {
  await git(["--version"]).catch(() => {
    throw new Error("git is required: the memory service keeps each wiki's history in a local git repository");
  });
}

export class History {
  /** 이 프로세스에서 저장소를 확인한 wiki */
  private readonly ready = new Set<string>();

  /** 저장소를 지정해서 실행한다 (위쪽 디렉토리의 다른 저장소를 찾아 올라가지 않는다). */
  private at(root: string, args: string[], options?: { ok?: number[]; author?: string }): Promise<number> {
    return git([`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`, ...args], options);
  }

  /**
   * wiki를 바꾸기 전에 부른다 (주인의 lock 안, `root`는 이미 있다). 저장소가 없으면 만들고,
   * 이력에 없는 내용(이력이 생기기 전의 노트, 커밋하지 못한 변경)을 먼저 커밋해서 바꾸기 전 상태를 남긴다.
   */
  async begin(root: string, owner: string): Promise<void> {
    if (this.ready.has(root)) return;
    if (!(await lstat(join(root, ".git")).catch(() => null))) {
      await git(["init", "-q", "--template=", "--initial-branch=main", root]);
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "exclude"), EXCLUDE);
    }
    const started = (await this.at(root, ["rev-parse", "-q", "--verify", "HEAD"], { ok: [0, 1] })) === 0;
    await this.record(root, owner, started ? "changes saved without a history entry" : "notes from before history began");
    this.ready.add(root);
  }

  /** wiki의 지금 상태를 한 커밋으로 남긴다. 바뀐 것이 없으면 남기지 않는다. */
  async record(root: string, owner: string, message: string): Promise<void> {
    try {
      await this.at(root, ["add", "-A"]);
      if ((await this.at(root, ["diff", "--cached", "--quiet"], { ok: [0, 1] })) === 0) return;
      await this.at(root, ["commit", "-q", "-m", message], { author: owner });
    } catch (err) {
      this.ready.delete(root);
      throw err;
    }
  }

  /** wiki를 통째로 지운 뒤에 부른다. 다음 쓰기가 저장소를 다시 만든다. */
  forget(root: string): void {
    this.ready.delete(root);
  }
}
