import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PlatformError } from "../admin/errors.js";

export interface CopyLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxDepth: number;
}

const MiB = 1024 * 1024;
export const DEFAULT_COPY_LIMITS: CopyLimits = {
  maxFiles: 5000,
  maxTotalBytes: 200 * MiB,
  maxFileBytes: 50 * MiB,
  maxDepth: 32,
};

export interface CopyResult {
  files: number;
  bytes: number;
  skipped: { path: string; reason: string }[];
}

/** 경로가 root 자신이거나 root 아래에 있는지 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

const SKIP_NAMES = new Set([".git"]);

export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * 저장소(또는 staging) 안의 파일을 읽는다. 신뢰할 수 없는 내용이라고 가정한다.
 * - relPath는 `..`·절대 경로·역슬래시 없이 root 기준이어야 한다.
 * - 마지막 구성요소가 심볼릭 링크면 거절한다 (`symlink_refused`).
 * - 중간 디렉토리 링크로 root 밖에 닿으면 거절한다 (`outside_repository`).
 * - 일반 파일이 아니거나 maxBytes를 넘으면 거절한다.
 * 오류 메시지에는 root 기준 상대 경로만 넣는다 (파일 내용·절대 경로는 넣지 않는다).
 * optional이면 파일이 없을 때 undefined를 돌려준다.
 */
export async function readContainedFile(
  root: string,
  relPath: string,
  options: { maxBytes?: number; optional?: boolean } = {},
): Promise<string | undefined> {
  const label = relPath.replace(/^\.\//, "");
  if (!label || isAbsolute(label) || label.includes("\\") || label.split("/").includes("..")) {
    throw new PlatformError(400, "invalid_path", `invalid file path '${label}'`);
  }
  const rootReal = await realpath(root);
  const target = join(rootReal, label);
  let info;
  try {
    info = await lstat(target);
  } catch {
    if (options.optional) return undefined;
    throw new PlatformError(400, "not_found", `${label} not found`);
  }
  if (info.isSymbolicLink()) throw new PlatformError(400, "symlink_refused", `${label} must not be a symbolic link`);
  if (!info.isFile()) throw new PlatformError(400, "invalid_path", `${label} is not a regular file`);
  const real = await realpath(target);
  if (!isInside(rootReal, real)) throw new PlatformError(400, "outside_repository", `${label} points outside the repository`);
  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  if (info.size > maxBytes) throw new PlatformError(400, "plugin_too_large", `${label} is larger than ${maxBytes} bytes`);
  return readFile(real, "utf8");
}

/** readContainedFile의 동기 버전 (시작 시 마이그레이션용). 거절할 때는 undefined를 돌려준다. */
export function readContainedFileSync(root: string, relPath: string, maxBytes = MAX_MANIFEST_BYTES): string | undefined {
  const label = relPath.replace(/^\.\//, "");
  if (!label || isAbsolute(label) || label.includes("\\") || label.split("/").includes("..")) return undefined;
  try {
    const rootReal = realpathSync(root);
    const target = join(rootReal, label);
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return undefined;
    const real = realpathSync(target);
    if (!isInside(rootReal, real)) return undefined;
    return readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * plugin 디렉토리를 복사한다. 신뢰할 수 없는 내용이라고 가정한다.
 * - 심볼릭 링크: plugin 안의 일반 파일을 가리키면 내용을 복사하고, 밖을 가리키거나 디렉토리면 건너뛴다.
 * - FIFO·소켓·장치 파일, 하드 링크가 여러 개인 파일은 건너뛴다.
 * - 파일 수·크기·깊이 제한을 넘으면 실패한다.
 * - 권한은 0644(실행 비트가 있으면 0755), 디렉토리는 0755로 정리한다.
 */
export async function safeCopyTree(srcRoot: string, destRoot: string, limits: CopyLimits = DEFAULT_COPY_LIMITS): Promise<CopyResult> {
  const root = await realpath(srcRoot);
  const result: CopyResult = { files: 0, bytes: 0, skipped: [] };
  await mkdir(destRoot, { recursive: true, mode: 0o755 });
  await chmod(destRoot, 0o755);

  const addFile = async (from: string, to: string, size: number, mode: number, display: string) => {
    if (size > limits.maxFileBytes) throw tooLarge(`file ${display} is larger than ${limits.maxFileBytes} bytes`);
    result.files += 1;
    result.bytes += size;
    if (result.files > limits.maxFiles) throw tooLarge(`plugin has more than ${limits.maxFiles} files`);
    if (result.bytes > limits.maxTotalBytes) throw tooLarge(`plugin is larger than ${limits.maxTotalBytes} bytes`);
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await chmod(to, mode & 0o111 ? 0o755 : 0o644);
  };

  const walk = async (dir: string, dest: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw tooLarge(`plugin directories are nested deeper than ${limits.maxDepth}`);
    const entries = await readdir(dir);
    entries.sort();
    for (const name of entries) {
      const from = join(dir, name);
      const to = join(dest, name);
      const display = relative(root, from) || name;
      if (SKIP_NAMES.has(name)) {
        continue;
      }
      const info = await lstat(from);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(from), await readlink(from));
        let real: string;
        try {
          real = await realpath(target);
        } catch {
          result.skipped.push({ path: display, reason: "broken symlink" });
          continue;
        }
        if (!isInside(root, real)) {
          result.skipped.push({ path: display, reason: "symlink points outside the plugin" });
          continue;
        }
        const targetInfo = await stat(real);
        if (!targetInfo.isFile()) {
          result.skipped.push({ path: display, reason: "symlink to a directory or special file" });
          continue;
        }
        if (targetInfo.nlink > 1) {
          result.skipped.push({ path: display, reason: "hard-linked file" });
          continue;
        }
        await addFile(real, to, targetInfo.size, targetInfo.mode, display);
        continue;
      }
      if (info.isDirectory()) {
        await mkdir(to, { mode: 0o755 });
        // umask와 관계없이 sandbox 사용자가 읽을 수 있게 한다.
        await chmod(to, 0o755);
        await walk(from, to, depth + 1);
        continue;
      }
      if (info.isFile()) {
        if (info.nlink > 1) {
          result.skipped.push({ path: display, reason: "hard-linked file" });
          continue;
        }
        await addFile(from, to, info.size, info.mode, display);
        continue;
      }
      result.skipped.push({ path: display, reason: "special file" });
    }
  };

  await walk(root, destRoot, 0);
  return result;
}

function tooLarge(message: string): PlatformError {
  return new PlatformError(400, "plugin_too_large", message);
}
