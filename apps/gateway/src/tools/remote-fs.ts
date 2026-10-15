import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_HOME, SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { SandboxError, type SandboxHandle } from "../sandbox/client.js";
import { checkImage, imageNotice, sniffImageFormat } from "./image-guard.js";

/**
 * pi 내장 파일 도구(read/write/edit/ls/find)의 operations를 sandboxd로 보낸다.
 * gateway 로컬 파일시스템은 읽거나 쓰지 않는다.
 *
 * 경로 이름공간: pi의 read/write/edit은 operations와 별개로 gateway 로컬 경로를 만진다
 * (read는 macOS 파일 이름 변형을 로컬 access로 찾고, write/edit은 프로세스 전역 queue 키를
 * 로컬 realpath로 만든다). 그래서 pi에는 gateway에 존재할 수 없는 세션별 경로
 * `/.pi-sbx/<key>/<sandbox 경로>`만 보여주고, operations에서 접두사를 떼어 sandbox로 보낸다.
 * 이렇게 하면 로컬 파일 존재 여부·권한이 새지 않고, 다른 세션과 queue를 공유하지도 않는다.
 */

/** pi read는 파일 전체를 메모리에 올린다. 이보다 크면 bash로 일부만 읽게 안내한다. */
export const MAX_READ_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 5_000;
const NAMESPACE_ROOT = "/.pi-sbx";

function fsError(code: string, syscall: string, path: string, message: string): Error {
  const err = new Error(`${code}: ${message}, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.path = path;
  err.syscall = syscall;
  return err;
}

/** sandboxd 오류를 Node fs 오류처럼 바꾼다. 모델이 보는 메시지가 로컬 도구와 비슷해진다. */
export function toFsError(err: unknown, syscall: string, path: string): Error {
  if (!(err instanceof SandboxError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.code) {
    case "not_found":
      return fsError("ENOENT", syscall, path, "no such file or directory");
    case "is_directory":
      return fsError("EISDIR", syscall, path, "illegal operation on a directory");
    case "not_directory":
      return fsError("ENOTDIR", syscall, path, "not a directory");
    case "permission_denied":
    case "forbidden":
      return fsError("EACCES", syscall, path, "permission denied");
    case "too_large":
      return new Error(`File is too large to read: ${path}. Use bash (head, sed -n, tail) to read parts of it.`);
    default:
      return new Error(`Sandbox error (${err.code}): ${err.message}`);
  }
}

/** 모델이 준 경로를 sandbox 안의 절대 경로로: `@` 접두사, `~`, `file://`, 상대 경로를 처리한다. */
export function resolveSandboxPath(path: string, cwd: string = SANDBOX_WORKSPACE): string {
  let p = path.startsWith("@") ? path.slice(1) : path;
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p);
    } catch {
      /* 그대로 둔다 */
    }
  }
  if (p === "~") p = SANDBOX_HOME;
  else if (p.startsWith("~/")) p = posix.join(SANDBOX_HOME, p.slice(2));
  return posix.resolve(cwd, p);
}

/** `~` 경로만 sandbox HOME으로 바꾼다 (pi는 gateway의 os.homedir()로 펼치므로 그 전에). */
export function mapHomePath(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.startsWith("@") ? value.slice(1) : value;
  if (v === "~") return SANDBOX_HOME;
  if (v.startsWith("~/")) return posix.join(SANDBOX_HOME, v.slice(2));
  return value;
}

/** 세션별 경로 이름공간 (위 설명 참고) */
export class PathNamespace {
  readonly prefix: string;

  constructor(key: string = randomBytes(8).toString("hex")) {
    this.prefix = `${NAMESPACE_ROOT}/${key}`;
  }

  /** 모델 경로 → pi에 보여줄 경로 */
  wrap(path: string, cwd: string = SANDBOX_WORKSPACE): string {
    return this.prefix + resolveSandboxPath(path, cwd);
  }

  /** pi가 넘긴 경로 → sandbox 경로. 이름공간 밖의 경로는 그대로 둔다. */
  unwrap(path: string): string {
    if (path === this.prefix) return "/";
    return path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length) : path;
  }

  /** 도구 결과(문자열·배열·객체)에서 접두사를 지운다 */
  strip<T>(value: T): T {
    if (typeof value === "string") return value.split(this.prefix).join("") as T;
    if (Array.isArray(value)) return value.map((v) => this.strip(v)) as T;
    if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.strip(v);
      return out as T;
    }
    return value;
  }
}

type CacheEntry = { at: number; content?: Buffer; error?: Error };

export interface RemoteFs {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  find: FindOperations;
}

export interface RemoteFsOptions {
  /** pi가 넘긴 경로를 sandbox 경로로 바꾼다 (PathNamespace.unwrap) */
  unwrap?: (path: string) => string;
}

export function createRemoteFs(sandbox: SandboxHandle, options: RemoteFsOptions = {}): RemoteFs {
  const unwrap = options.unwrap ?? ((p: string) => p);
  // access → detectImageMimeType → readFile 순서로 불리므로, 한 번 읽은 내용을 잠시 보관해 왕복을 줄인다.
  const readCache = new Map<string, CacheEntry>();
  const kindCache = new Map<string, { at: number; isDir: boolean | null }>();
  // 검사에서 걸린 이미지: read에는 이미지 대신 이 안내 텍스트를 준다 (pi가 디코딩하지 않게).
  const blockedImages = new Map<string, string>();

  const fresh = (at: number) => Date.now() - at < CACHE_TTL_MS;

  const fetchFile = async (path: string): Promise<CacheEntry> => {
    const cached = readCache.get(path);
    if (cached && fresh(cached.at)) return cached;
    let entry: CacheEntry;
    try {
      const res = await sandbox.readFile(path, MAX_READ_BYTES);
      entry = res.truncated
        ? { at: Date.now(), error: toFsError(new SandboxError("too_large", "file too large"), "open", path) }
        : { at: Date.now(), content: res.content };
    } catch (err) {
      entry = { at: Date.now(), error: toFsError(err, "open", path) };
    }
    readCache.set(path, entry);
    return entry;
  };

  const access = async (piPath: string): Promise<void> => {
    const path = unwrap(piPath);
    const entry = await fetchFile(path);
    // 디렉토리는 access는 통과하고 readFile에서 EISDIR을 낸다 (Node와 같다).
    if (entry.error && (entry.error as NodeJS.ErrnoException).code !== "EISDIR") {
      readCache.delete(path);
      throw entry.error;
    }
  };

  const readFile = async (piPath: string): Promise<Buffer> => {
    const path = unwrap(piPath);
    const entry = await fetchFile(path);
    readCache.delete(path);
    if (entry.error) throw entry.error;
    return entry.content!;
  };

  const writeFile = async (piPath: string, content: string): Promise<void> => {
    const path = unwrap(piPath);
    readCache.delete(path);
    kindCache.delete(path);
    blockedImages.delete(path);
    try {
      await sandbox.writeFile(path, content);
    } catch (err) {
      throw toFsError(err, "open", path);
    }
  };

  const statKind = async (path: string): Promise<boolean | null> => {
    const cached = kindCache.get(path);
    if (cached && fresh(cached.at)) return cached.isDir;
    const st = await sandbox.stat(path);
    const isDir = !st.exists ? null : st.kind === "dir" || st.targetIsDir === true;
    kindCache.set(path, { at: Date.now(), isDir });
    return isDir;
  };

  return {
    read: {
      access,
      readFile: async (piPath) => {
        const notice = blockedImages.get(unwrap(piPath));
        if (notice !== undefined) {
          blockedImages.delete(unwrap(piPath));
          return Buffer.from(notice, "utf8");
        }
        return readFile(piPath);
      },
      detectImageMimeType: async (piPath) => {
        const path = unwrap(piPath);
        const entry = await fetchFile(path);
        if (!entry.content || !sniffImageFormat(entry.content)) return null;
        const verdict = checkImage(entry.content);
        if (verdict.ok) return verdict.info.mimeType;
        // 이미지로 넘기지 않는다: read는 텍스트로 처리하고 readFile이 안내문을 돌려준다.
        blockedImages.set(path, imageNotice(path, verdict.reason));
        return null;
      },
    },
    edit: { access, readFile, writeFile },
    write: {
      writeFile,
      // fs/write가 상위 디렉토리를 만든다 (mkdirs=true).
      mkdir: async () => {},
    },
    ls: {
      exists: async (path) => (await statKind(unwrap(path))) !== null,
      stat: async (piPath) => {
        const path = unwrap(piPath);
        const isDir = await statKind(path);
        if (isDir === null) throw fsError("ENOENT", "stat", path, "no such file or directory");
        return { isDirectory: () => isDir };
      },
      readdir: async (piPath) => {
        const path = unwrap(piPath);
        try {
          const entries = await sandbox.list(path);
          const now = Date.now();
          for (const e of entries) {
            // 심볼릭 링크는 대상 종류를 모르므로 stat 때 다시 묻는다.
            if (e.kind !== "symlink") kindCache.set(posix.join(path, e.name), { at: now, isDir: e.kind === "dir" });
          }
          return entries.map((e) => e.name);
        } catch (err) {
          throw toFsError(err, "scandir", path);
        }
      },
    },
    find: {
      exists: async (path) => (await statKind(unwrap(path))) !== null,
      glob: async (pattern, cwd, globOptions) => {
        const res = await sandbox.glob({ cwd: unwrap(cwd), pattern, ignore: globOptions.ignore, limit: globOptions.limit });
        return res.paths;
      },
    },
  };
}
