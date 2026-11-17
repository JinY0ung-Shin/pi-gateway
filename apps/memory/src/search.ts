/**
 * 노트 검색. 단어가 제목·별칭(5점), 태그(3점), 본문(1점)에 있는지로 순위를 매긴다.
 * embedding이나 색인 서버는 쓰지 않는다 (Noah의 brainSearch.ts에서 옮겨 왔다).
 */

/** 한 번의 검색이 읽는 노트 수. 넘는 노트(경로 순으로 뒤쪽)는 읽지 않고, 결과에 그 수를 알린다. */
export const SCAN_CAP = 2000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const SNIPPET_RADIUS = 90;

export interface SearchHit {
  path: string;
  title: string;
  tags: string[];
  snippet: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 읽지 않은 노트 수 (0이면 전부 읽었다) */
  unscanned: number;
}

interface Frontmatter {
  title: string;
  tags: string[];
  aliases: string[];
}

const unquote = (v: string) => v.replace(/^["']|["']$/g, "").trim();

const inlineList = (v: string) =>
  v
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((x) => unquote(x.trim()))
    .filter(Boolean);

/** frontmatter를 여닫는 줄은 `---`만 있는 줄이다 (`----`나 `---글`은 아니다). */
const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/m;

/**
 * 맨 앞의 `---` 블록에서 title·tags·aliases만 읽는다 (YAML 전체를 해석하지 않는다).
 * 블록이 없거나 깨져 있으면 빈 값으로 두고 본문만으로 찾는다.
 */
export function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  const fm: Frontmatter = { title: "", tags: [], aliases: [] };
  const open = OPEN.exec(content);
  if (!open) return { fm, body: content };
  const rest = content.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { fm, body: content };
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  let listKey: "tags" | "aliases" | null = null;
  for (const raw of rest.slice(0, close.index).split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const v = unquote(item[1]!);
      if (v) fm[listKey].push(v);
      continue;
    }
    // 다른 key가 나오면 list가 끝난다. 주석 같은 그 밖의 줄은 list를 끊지 않는다.
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = null;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (key === "title") {
      fm.title = unquote(val);
    } else if (key === "tags" || key === "aliases") {
      if (val.startsWith("[")) fm[key] = inlineList(val);
      else if (val) fm[key] = [unquote(val)];
      else {
        fm[key] = [];
        listKey = key;
      }
    }
  }
  return { fm, body };
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - SNIPPET_RADIUS);
  const end = start + SNIPPET_RADIUS * 2;
  return `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
}

/**
 * `paths`(경로 순)의 노트를 `query`로 순위 매긴다. `read`가 null을 주는 노트는 건너뛴다.
 * 점수가 같으면 경로 순이라 결과가 늘 같다.
 */
export async function searchNotes(
  paths: string[],
  read: (path: string) => Promise<string | null>,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<SearchResult> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scanned = paths.slice(0, SCAN_CAP);
  const hits: SearchHit[] = [];
  for (const path of scanned) {
    const content = await read(path);
    if (content === null) continue;
    const { fm, body } = parseFrontmatter(content);
    const title = fm.title || (path.split("/").pop() ?? path).replace(/\.md$/, "");
    const titleHay = `${title} ${fm.aliases.join(" ")}`.toLowerCase();
    const tagHay = fm.tags.join(" ").toLowerCase();
    // 본문 점수는 노트 전체에서 본다: 맨 앞 블록에 든 글(다른 key의 값, 수평선 사이의 문단)도 검색에서 빠지지 않는다.
    const bodyHay = content.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (titleHay.includes(t)) score += 5;
      if (tagHay.includes(t)) score += 3;
      if (bodyHay.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ path, title, tags: fm.tags, snippet: snippet(body, terms), score });
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return { hits: hits.slice(0, Math.min(Math.max(1, limit), MAX_LIMIT)), unscanned: paths.length - scanned.length };
}
