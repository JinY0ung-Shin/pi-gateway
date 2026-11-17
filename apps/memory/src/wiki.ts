import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import { type SearchResult, searchNotes } from "./search.js";

/**
 * 주인(사용자)마다 하나씩 있는 markdown wiki. 파일은 `<dataDir>/wikis/<owner key>/` 아래에 있다.
 * - 이 서비스만 쓴다. sandbox workspace가 아니고, 실행하지 않는다.
 * - 경로는 `.md`로 끝나는 상대 경로만 받고, 링크는 따라가지 않는다.
 * - 있는 노트를 바꾸거나 지우려면 읽을 때 받은 hash를 내야 한다. 그 사이 바뀐 노트는 덮어쓰지 않고 거절한다.
 */

/** 노트 하나의 최대 크기. Noah의 노트 한도(512KiB)보다 작으면 안 된다 (기존 vault를 옮겨 온다). */
export const MAX_NOTE_BYTES = 512 * 1024;
/**
 * read 한 번이 돌려주는 최대 크기. gateway는 50KB가 넘는 MCP 결과를 앞부분만 모델에 주므로 그보다 작게 둔다.
 * 이보다 큰 노트는 여러 번에 나눠 읽고, write로 통째로 바꿀 수 없다 (모델이 보지 못한 뒷부분이 사라진다).
 */
export const READ_PAGE_BYTES = 32 * 1024;
/** wiki 하나의 최대 노트 수와 전체 크기 */
export const MAX_NOTES = 10_000;
export const MAX_WIKI_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_SEGMENT_BYTES = 255;
const MAX_DEPTH = 16;

export type WikiErrorCode =
  | "invalid_path"
  | "invalid_content"
  | "not_found"
  | "exists"
  | "stale"
  | "too_large"
  | "invalid_offset"
  | "invalid_query"
  | "wiki_full"
  | "no_match"
  | "ambiguous"
  | "no_change";

/** 호출한 쪽이 고칠 수 있는 거절. 메시지는 모델이 읽는다. */
export class WikiError extends Error {
  override name = "WikiError";
  constructor(
    readonly code: WikiErrorCode,
    message: string,
    /** `stale`인데 노트가 아예 없어진 경우 (지우려던 쪽에게는 이미 끝난 일이다) */
    readonly gone = false,
  ) {
    super(message);
  }
}

/** 노트 hash의 모양 (sha256 hex) */
export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface NoteEntry {
  path: string;
  bytes: number;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 없는 파일은 null로 본다. 그 밖의 실패는 그대로 던진다. */
const missingAsNull = (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT") return null;
  throw err;
};

/** 쓰는 동안만 있는 임시 파일 (wiki 맨 위에 둔다) */
const TMP_NAME = /^\.[0-9a-f]{16}\.tmp$/;

function segmentsOf(raw: string): string[] {
  const text = raw.normalize("NFC");
  if (Buffer.byteLength(text) > MAX_PATH_BYTES) throw new WikiError("invalid_path", `a path is at most ${MAX_PATH_BYTES} bytes`);
  if (/[\u0000-\u001f\u007f\\]/.test(text)) throw new WikiError("invalid_path", "a path must not contain control characters or backslashes");
  const segments = text.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length > MAX_DEPTH) throw new WikiError("invalid_path", `a path has at most ${MAX_DEPTH} parts (folders and the note name)`);
  for (const s of segments) {
    if (s.startsWith(".")) throw new WikiError("invalid_path", `'${s}': a folder or note name must not start with a dot`);
    if (Buffer.byteLength(s) > MAX_SEGMENT_BYTES) throw new WikiError("invalid_path", `a folder or note name is at most ${MAX_SEGMENT_BYTES} bytes`);
  }
  return segments;
}

/** 노트 경로를 검사하고 정리한다 (앞의 `/`·`./` 제거, NFC). `..`이나 점으로 시작하는 이름, `.md`가 아닌 파일은 거절한다. */
export function normalizeNotePath(raw: string): string {
  const segments = segmentsOf(raw);
  if (!segments.at(-1)?.endsWith(".md")) throw new WikiError("invalid_path", "a note path is a relative path that ends with .md (e.g. projects/deploy.md)");
  return segments.join("/");
}

/** 폴더 접두사. 비어 있으면 wiki 전체다. */
function normalizePrefix(raw: string | undefined): string {
  return raw === undefined ? "" : segmentsOf(raw).join("/");
}

/**
 * wiki 안의 경로를 실제 경로로 바꾼다. 이미 있는 부분은 하나씩 확인해서, 폴더가 아닌 것(링크 포함)을 지나가거나
 * 마지막이 `want`(노트 = 파일, 폴더)가 아닌 것(링크 포함)이면 거절한다. `size`가 null이면 아직 없다.
 */
async function locate(root: string, rel: string, want: "note" | "folder" = "note"): Promise<{ abs: string; size: number | null }> {
  const segments = rel.split("/");
  let current = root;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current).catch(missingAsNull);
    if (!info) return { abs: join(root, rel), size: null };
    const last = i === segments.length - 1;
    const kind = last ? want : "folder";
    if (kind === "note" ? !info.isFile() : !info.isDirectory()) throw new WikiError("invalid_path", `${rel}: '${segment}' is not a ${kind}`);
    if (last) return { abs: current, size: info.size };
  }
  throw new WikiError("invalid_path", "empty path");
}

interface FoundNote {
  path: string;
  abs: string;
}

/** `dir`(wiki 안의 경로로는 `rel`, 맨 위면 "") 아래의 모든 노트 (경로 순). 점으로 시작하는 이름과 링크는 보지 않는다. */
async function walk(dir: string, rel: string): Promise<FoundNote[]> {
  const notes: FoundNote[] = [];
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(missingAsNull)) ?? []) {
      if (entry.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await visit(join(dir, entry.name), path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        notes.push({ path, abs: join(dir, entry.name) });
      }
    }
  };
  await visit(dir, rel, rel ? rel.split("/").length + 1 : 1);
  return notes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** 노트마다 크기를 붙인다. 목록을 읽은 뒤 지워진 노트는 건너뛴다 (list·search는 쓰기와 같은 줄에 서지 않는다). */
async function sized(notes: FoundNote[]): Promise<NoteEntry[]> {
  const entries: NoteEntry[] = [];
  for (const note of notes) {
    const info = await lstat(note.abs).catch(missingAsNull);
    if (info) entries.push({ path: note.path, bytes: info.size });
  }
  return entries;
}

/** 검색이 읽는 노트의 글. 그 사이 지워진 노트와 한도보다 큰 파일은 null이다 (건너뛴다). 그 밖의 읽기 실패는 던진다. */
async function textOf(abs: string): Promise<string | null> {
  const info = await lstat(abs).catch(missingAsNull);
  if (!info?.isFile() || info.size > MAX_NOTE_BYTES) return null;
  return (await readFile(abs).catch(missingAsNull))?.toString("utf8") ?? null;
}

/** 디렉토리를 디스크에 내린다 (그 안에 새로 생긴 이름이 전원이 나가도 남게). */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 임시 파일에 써서 디스크에 내린 뒤 이름을 바꾼다 (읽는 쪽이 반쯤 쓴 노트를 보지 않는다).
 * 임시 파일은 wiki 맨 위(`root`)에 둔다: 쓰다가 죽어 남아도 노트 폴더를 비우는 것을 막지 않는다.
 */
async function atomicWrite(root: string, abs: string, bytes: Buffer): Promise<void> {
  const tmp = join(root, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function encode(content: string): Buffer {
  if (content.includes("\0")) throw new WikiError("invalid_content", "a note is text; it must not contain NUL characters");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_NOTE_BYTES) throw new WikiError("too_large", `a note is at most ${MAX_NOTE_BYTES} bytes; this one is ${bytes.length}. Split it into several notes`);
  return bytes;
}

export interface WikiLimits {
  maxNotes: number;
  maxWikiBytes: number;
}

export class WikiStore {
  /** 주인별로 쓰기를 한 줄로 세운다 (hash 확인과 쓰기 사이에 다른 쓰기가 끼지 않게). */
  private readonly tails = new Map<string, Promise<unknown>>();
  /**
   * 주인별 노트 수와 전체 크기. 처음 쓸 때 한 번 세고, 그 뒤로는 쓰기·삭제마다 고친다.
   * (쓸 때마다 wiki 전체를 세면 노트 10,000개에서 한 번에 0.8초쯤 걸린다.) 쓰는 것은 이 서비스뿐이라 어긋나지 않고,
   * 쓰다 실패하면 버리고 다음에 다시 센다.
   */
  private readonly usage = new Map<string, { notes: number; bytes: number }>();

  constructor(
    private readonly dataDir: string,
    private readonly limits: WikiLimits = { maxNotes: MAX_NOTES, maxWikiBytes: MAX_WIKI_BYTES },
  ) {}

  private root(owner: string): string {
    return join(this.dataDir, "wikis", userKey(owner));
  }

  private locked<T>(owner: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(owner) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.tails.set(owner, tail);
    void tail.then(() => {
      if (this.tails.get(owner) === tail) this.tails.delete(owner);
    });
    return run;
  }

  /** `prefix` 폴더(없으면 wiki 전체) 아래의 노트. 그 폴더부터 걷는다. */
  private async notesUnder(owner: string, prefix?: string): Promise<FoundNote[]> {
    const root = this.root(owner);
    const under = normalizePrefix(prefix);
    if (!under) return walk(root, "");
    const folder = await locate(root, under, "folder");
    return folder.size === null ? [] : walk(folder.abs, under);
  }

  async list(owner: string, prefix?: string): Promise<NoteEntry[]> {
    return sized(await this.notesUnder(owner, prefix));
  }

  /**
   * 노트를 `offset`(바이트)부터 READ_PAGE_BYTES까지 읽는다. hash는 늘 노트 전체의 것이다.
   * 남은 부분이 있으면 `next`가 이어 읽을 offset이다. 줄 끝에서 끊고, 글자 중간에서는 끊지 않는다.
   * 이어 읽을 때는 앞부분을 읽을 때 받은 `hash`를 낸다. 그 사이 바뀐 노트는 이어 읽지 않고 거절한다 (offset이 다른 글을 가리킨다).
   */
  async read(
    owner: string,
    path: string,
    offset = 0,
    hash?: string,
  ): Promise<{ path: string; content: string; hash: string; offset: number; next: number | null; total: number }> {
    const rel = normalizeNotePath(path);
    const bytes = await this.bytesOf(this.root(owner), rel);
    // 이 서비스가 쓴 노트는 늘 UTF-8이다. 볼륨에 직접 놓인 다른 파일은 깨진 글로 돌려주지 않는다.
    if (!isUtf8(bytes)) throw new WikiError("invalid_content", `${rel} is not UTF-8 text and cannot be read`);
    const current = sha256(bytes);
    if (offset > 0 && hash !== current) {
      throw hash === undefined
        ? new WikiError("invalid_offset", "reading from an offset needs the `hash` the previous read of this note gave")
        : new WikiError("stale", `${rel} changed since its previous part was read, so the offset no longer fits. Read it again from the start`);
    }
    const total = bytes.length;
    if (offset < 0 || offset > total || (offset === total && total > 0) || (bytes[offset] ?? 0) >> 6 === 0b10) {
      throw new WikiError("invalid_offset", `offset ${offset} is not a position in ${rel} (${total} bytes). Use the offset the previous read gave`);
    }
    let end = Math.min(total, offset + READ_PAGE_BYTES);
    if (end < total) {
      const newline = bytes.lastIndexOf(0x0a, end - 1);
      if (newline >= offset) end = newline + 1;
      else while (end > offset && bytes[end]! >> 6 === 0b10) end--;
    }
    return { path: rel, content: bytes.subarray(offset, end).toString("utf8"), hash: current, offset, next: end < total ? end : null, total };
  }

  /** 노트 전체를 읽는다. 프로그램(BFF)용이다: 모델에게는 `read`가 나눠 준다. */
  async readWhole(owner: string, path: string): Promise<{ path: string; content: string; hash: string }> {
    const rel = normalizeNotePath(path);
    const bytes = await this.bytesOf(this.root(owner), rel);
    if (!isUtf8(bytes)) throw new WikiError("invalid_content", `${rel} is not UTF-8 text and cannot be read`);
    return { path: rel, content: bytes.toString("utf8"), hash: sha256(bytes) };
  }

  private async bytesOf(root: string, rel: string): Promise<Buffer> {
    const at = await locate(root, rel);
    if (at.size !== null && at.size > MAX_NOTE_BYTES) throw new WikiError("too_large", `${rel} is larger than ${MAX_NOTE_BYTES} bytes and cannot be read`);
    // 찾은 뒤 읽기 전에 지워진 노트도 없는 노트다.
    const bytes = at.size === null ? null : await readFile(at.abs).catch(missingAsNull);
    if (!bytes) throw new WikiError("not_found", `no note at ${rel}. Use search or list to find the path`);
    return bytes;
  }

  /** 지금 내용이 `hash`와 같은지 본다. 다르면 거절한다. */
  private async current(root: string, rel: string, hash: string): Promise<Buffer> {
    const bytes = await this.bytesOf(root, rel).catch((err) => {
      if (err instanceof WikiError && err.code === "not_found") throw new WikiError("stale", `${rel} does not exist any more: it was deleted since it was read`, true);
      throw err;
    });
    if (sha256(bytes) !== hash) throw new WikiError("stale", `${rel} changed since it was read. Read it again and redo the change on the current text`);
    return bytes;
  }

  private async usageOf(owner: string, root: string): Promise<{ notes: number; bytes: number }> {
    let used = this.usage.get(owner);
    if (!used) {
      // 여기는 주인의 lock 안이라, 남아 있는 임시 파일은 쓰다가 죽은 것이다.
      for (const name of (await readdir(root).catch(missingAsNull)) ?? []) {
        if (TMP_NAME.test(name)) await rm(join(root, name), { force: true });
      }
      const notes = await sized(await walk(root, ""));
      used = { notes: notes.length, bytes: notes.reduce((sum, n) => sum + n.bytes, 0) };
      this.usage.set(owner, used);
    }
    return used;
  }

  /** 한도를 확인하고 쓴다 (주인의 lock 안에서 부른다). `previous`는 바꾸기 전 크기 (새 노트면 null). */
  private async put(owner: string, root: string, rel: string, bytes: Buffer, previous: number | null): Promise<string> {
    const used = await this.usageOf(owner, root);
    const { maxNotes, maxWikiBytes } = this.limits;
    if (previous === null && used.notes >= maxNotes) throw new WikiError("wiki_full", `this wiki already holds ${maxNotes} notes; delete or merge notes first`);
    const total = used.bytes - (previous ?? 0) + bytes.length;
    if (total > maxWikiBytes) throw new WikiError("wiki_full", `this wiki would exceed ${maxWikiBytes} bytes; delete or shorten notes first`);
    const abs = join(root, rel);
    try {
      const made = await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
      await atomicWrite(root, abs, bytes);
      // "저장했다"고 답한 노트가 남도록, 새 이름이 생긴 디렉토리(노트의 폴더와 새로 만든 폴더들의 부모)를 디스크에 내린다.
      const top = made ? dirname(made) : dirname(abs);
      for (let dir = dirname(abs); ; dir = dirname(dir)) {
        await syncDir(dir);
        if (dir.length <= top.length) break;
      }
    } catch (err) {
      this.usage.delete(owner);
      throw err;
    }
    this.usage.set(owner, { notes: used.notes + (previous === null ? 1 : 0), bytes: total });
    return sha256(bytes);
  }

  /**
   * 새 노트를 만들거나(`hash` 없음), 있는 노트를 통째로 바꾼다(`hash` 필요).
   * `sawWhole`은 부르는 쪽이 노트 전체를 읽었다는 뜻이다 (readWhole을 쓰는 프로그램). 그때만 한 번에 읽히지 않는 긴 노트도 통째로 바꾼다.
   */
  async write(owner: string, path: string, content: string, hash?: string, sawWhole = false): Promise<{ path: string; hash: string; created: boolean }> {
    const rel = normalizeNotePath(path);
    const bytes = encode(content);
    return this.locked(owner, async () => {
      const root = this.root(owner);
      if (hash !== undefined) {
        const before = await this.current(root, rel, hash);
        if (!sawWhole && before.length > READ_PAGE_BYTES) {
          throw new WikiError(
            "too_large",
            `${rel} is ${before.length} bytes, more than one read returns (${READ_PAGE_BYTES}), so write cannot replace it as a whole: the part that was not read would be lost. Change it with edit, or delete it and write the new note`,
          );
        }
        return { path: rel, hash: await this.put(owner, root, rel, bytes, before.length), created: false };
      }
      if ((await locate(root, rel)).size !== null) {
        throw new WikiError("exists", `${rel} already exists. Read it and pass its hash to replace it, or use edit to change part of it`);
      }
      return { path: rel, hash: await this.put(owner, root, rel, bytes, null), created: true };
    });
  }

  /** 노트 안의 한 군데를 바꾼다. `oldText`는 정확히 한 번 나와야 한다. */
  async edit(owner: string, path: string, oldText: string, newText: string, hash: string): Promise<{ path: string; hash: string }> {
    const rel = normalizeNotePath(path);
    if (oldText === "") throw new WikiError("no_match", "old_text must not be empty");
    if (oldText === newText) throw new WikiError("no_change", "old_text and new_text are the same");
    return this.locked(owner, async () => {
      const root = this.root(owner);
      const before = await this.current(root, rel, hash);
      const text = before.toString("utf8");
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new WikiError("no_match", `old_text does not occur in ${rel}. Copy it exactly from the note, including whitespace`);
      if (count > 1) throw new WikiError("ambiguous", `old_text occurs ${count} times in ${rel}. Include more surrounding text so it matches once`);
      const bytes = encode(text.replace(oldText, () => newText));
      return { path: rel, hash: await this.put(owner, root, rel, bytes, before.length) };
    });
  }

  async delete(owner: string, path: string, hash: string): Promise<{ path: string }> {
    const rel = normalizeNotePath(path);
    return this.locked(owner, async () => {
      const root = this.root(owner);
      const before = await this.current(root, rel, hash);
      const abs = join(root, rel);
      const used = this.usage.get(owner);
      this.usage.delete(owner);
      await rm(abs);
      if (used) this.usage.set(owner, { notes: used.notes - 1, bytes: used.bytes - before.length });
      // 비게 된 폴더는 지운다. 비어 있지 않으면 rmdir이 실패하고 거기서 멈춘다.
      for (let dir = dirname(abs); dir !== root; dir = dirname(dir)) {
        if (!(await rmdir(dir).then(() => true, () => false))) break;
      }
      return { path: rel };
    });
  }

  /**
   * 주인의 wiki를 통째로 지운다 (그 사용자가 지워질 때). 없는 wiki를 지워도 된다.
   * 지웠다는 표시는 남기지 않는다: 그 뒤에 온 쓰기는 wiki를 다시 만든다. 부르는 쪽이 그 주인의 쓰기를 먼저 멈춘다.
   */
  async deleteAll(owner: string): Promise<void> {
    return this.locked(owner, async () => {
      this.usage.delete(owner);
      await rm(this.root(owner), { recursive: true, force: true });
    });
  }

  async search(owner: string, query: string, limit?: number, prefix?: string): Promise<SearchResult> {
    if (!query.trim()) throw new WikiError("invalid_query", "the query has no words to look for");
    const notes = await this.notesUnder(owner, prefix);
    const abs = new Map(notes.map((n) => [n.path, n.abs]));
    // 검색 도중 지워진 노트는 건너뛴다. 그 밖의 읽기 실패는 검색 실패다 (빈 결과로 바꾸지 않는다).
    return searchNotes([...abs.keys()], (path) => textOf(abs.get(path)!), query, limit);
  }
}
