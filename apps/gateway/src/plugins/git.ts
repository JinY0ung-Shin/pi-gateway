import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlatformError } from "../admin/errors.js";

export interface GitFetchOptions {
  url: string;
  ref?: string | undefined;
  sha?: string | undefined;
  dest: string;
  /** 작업용 임시 디렉토리의 부모 (askpass 스크립트, 빈 HOME) */
  tmpRoot: string;
  allowLocal: boolean;
  timeoutMs?: number | undefined;
  token?: string | undefined;
}

const SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!-)[A-Za-z0-9._/+-]{1,200}$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * git 원격 주소를 검사하고 정규화한다.
 * - https/http만 허용한다. 로컬 경로와 file://은 allowLocal일 때만 허용한다.
 * - URL에 들어 있는 사용자 이름·비밀번호는 거부한다 (PLUGIN_GIT_TOKEN을 쓴다).
 * - SSH(`git@host:…`)와 그 밖의 transport(ext:: 등)는 거부한다.
 * - `owner/repo`는 GitHub 주소로 바꾼다.
 */
export function normalizeGitUrl(input: string, allowLocal: boolean): string {
  const s = input.trim();
  if (!s || s.length > 2048 || /[\0\r\n]/.test(s)) throw new PlatformError(400, "invalid_url", "invalid git URL");
  if (GITHUB_SHORTHAND.test(s) && !s.startsWith(".")) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  if (s.startsWith("/")) {
    if (!allowLocal) throw new PlatformError(400, "invalid_url", "local paths are not allowed");
    return s;
  }
  if (/^[^/:@\s]+@[^/:\s]+:/.test(s)) throw new PlatformError(400, "invalid_url", "SSH URLs are not supported; use an https URL (and PLUGIN_GIT_TOKEN for private repositories)");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new PlatformError(400, "invalid_url", "invalid git URL");
  }
  if (url.protocol === "file:") {
    if (!allowLocal) throw new PlatformError(400, "invalid_url", "file:// URLs are not allowed");
    return url.toString();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PlatformError(400, "invalid_url", `unsupported git URL protocol '${url.protocol}'`);
  }
  if (url.username || url.password) {
    throw new PlatformError(400, "credentials_in_url", "do not put credentials in the URL; set PLUGIN_GIT_TOKEN instead");
  }
  return url.toString();
}

export function validateRef(ref: string | undefined): string | undefined {
  if (ref === undefined || ref === "") return undefined;
  if (!REF.test(ref) || ref.includes("..")) throw new PlatformError(400, "invalid_ref", "invalid git ref");
  return ref;
}

export function validateSha(sha: string | undefined): string | undefined {
  if (sha === undefined || sha === "") return undefined;
  if (!SHA.test(sha)) throw new PlatformError(400, "invalid_sha", "sha must be a full 40-character lowercase commit id");
  return sha;
}

/** 원격 저장소를 dest에 받는다. sha가 있으면 그 커밋을, 없으면 ref(또는 기본 브랜치)의 최신 커밋을 받는다. */
export async function gitFetch(options: GitFetchOptions): Promise<{ commit: string }> {
  const url = normalizeGitUrl(options.url, options.allowLocal);
  const ref = validateRef(options.ref);
  const sha = validateSha(options.sha);
  await mkdir(options.tmpRoot, { recursive: true });
  const work = await mkdtemp(join(options.tmpRoot, "git-"));
  try {
    const ctx = await prepareEnv(work, options);
    const run = (args: string[]) => runGit(args, ctx, options.timeoutMs ?? 120_000);
    if (!sha) {
      await run(["clone", "--depth", "1", "--no-tags", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, options.dest]);
    } else {
      await mkdir(options.dest, { recursive: true });
      await run(["init", "-q", options.dest]);
      await run(["-C", options.dest, "remote", "add", "origin", url]);
      try {
        await run(["-C", options.dest, "fetch", "--depth", "1", "--no-tags", "origin", sha]);
      } catch {
        // 일부 서버는 SHA로 직접 fetch할 수 없다. ref 전체를 받은 뒤 checkout한다.
        await run(["-C", options.dest, "fetch", "--no-tags", "origin", ...(ref ? [ref] : [])]);
      }
      await run(["-C", options.dest, "checkout", "-q", "--detach", sha]);
    }
    const commit = (await run(["-C", options.dest, "rev-parse", "HEAD"])).trim();
    if (!SHA.test(commit)) throw new PlatformError(502, "git_failed", "could not determine the checked-out commit");
    if (sha && commit !== sha) throw new PlatformError(502, "git_failed", `checked out ${commit} instead of ${sha}`);
    return { commit };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

interface GitContext {
  env: NodeJS.ProcessEnv;
  secrets: string[];
}

async function prepareEnv(work: string, auth: Pick<GitFetchOptions, "token" | "allowLocal">): Promise<GitContext> {
  const home = join(work, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: auth.allowLocal ? "https:http:file" : "https:http",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  // 사내 CA를 git도 믿게 한다. 이미지(Debian)의 git은 이 파일을 더해도 시스템 CA(/etc/ssl/certs)를 계속 믿는다.
  if (process.env.NODE_EXTRA_CA_CERTS) env.GIT_SSL_CAINFO = process.env.NODE_EXTRA_CA_CERTS;
  const secrets: string[] = [];
  if (auth.token) {
    const askpass = join(work, "askpass.sh");
    await writeFile(
      askpass,
      // 사용자 이름은 GitHub 형식(x-access-token)으로 고정한다.
      '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) printf \'%s\\n\' "$PI_GW_GIT_TOKEN" ;;\nesac\n',
      { mode: 0o700 },
    );
    await chmod(askpass, 0o700);
    env.GIT_ASKPASS = askpass;
    env.PI_GW_GIT_TOKEN = auth.token;
    secrets.push(auth.token);
  }
  return { env, secrets };
}

const SAFE_CONFIG = [
  // 저장소 안의 심볼릭 링크를 링크 대상 경로가 적힌 일반 파일로 받는다 (checkout 밖을 가리키는 링크를 만들지 않는다).
  "-c", "core.symlinks=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
  "-c", "protocol.ext.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "advice.detachedHead=false",
  "-c", "init.defaultBranch=main",
];

function runGit(args: string[], ctx: GitContext, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...args], {
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on("error", (error) => reject(new PlatformError(500, "git_unavailable", `could not run git: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) return resolvePromise(stdout);
      let message = stderr.trim() || `git exited with ${signal ?? code}`;
      for (const secret of ctx.secrets) message = message.split(secret).join("[REDACTED]");
      const reason = signal === "SIGKILL" ? "git timed out" : `git ${args.find((a) => !a.startsWith("-")) ?? ""} failed`;
      reject(new PlatformError(502, "git_failed", `${reason}: ${message.split("\n").slice(-3).join(" ")}`));
    });
  });
}
