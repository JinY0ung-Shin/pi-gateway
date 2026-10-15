import { parse as parseYaml } from "yaml";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  /** YAML 파싱에 실패해 줄 단위 대체 파서를 썼는지 */
  lenient: boolean;
}

const OPEN = /^---[ \t]*\r?\n/;

/**
 * Markdown 앞의 YAML frontmatter를 읽는다.
 * marketplace의 SKILL.md·command·agent 파일 중 상당수가 엄격한 YAML이 아니므로
 * (따옴표 없는 콜론, 잘못된 들여쓰기 등) 실패하면 `key: value` 줄 단위로 다시 읽는다.
 */
export function parseMarkdownFrontmatter(input: string): ParsedMarkdown {
  const text = input.replace(/^﻿/, "");
  const open = OPEN.exec(text);
  if (!open) return { frontmatter: {}, body: text, lenient: false };
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return { frontmatter: {}, body: text, lenient: false };
  const block = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  try {
    const parsed: unknown = parseYaml(block, { strict: false, uniqueKeys: false, prettyErrors: false });
    if (parsed === null || parsed === undefined) return { frontmatter: {}, body, lenient: false };
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body, lenient: false };
    }
  } catch {
    // 아래 대체 파서로 넘어간다.
  }
  return { frontmatter: parseLoose(block), body, lenient: true };
}

/** 최상위 `key: value`만 읽는다. 들여쓴 줄은 앞 키의 값에 이어 붙인다. */
function parseLoose(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  let parts: string[] = [];
  const flush = () => {
    if (key === null) return;
    const value = parts.join(" ").replace(/\s+/g, " ").trim();
    out[key] = unquote(value);
  };
  for (const line of block.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s?(.*)$/.exec(line);
    if (top && !/^\s/.test(line)) {
      flush();
      key = top[1] ?? null;
      const first = (top[2] ?? "").trim();
      parts = first === "|" || first === ">" || first === "|-" || first === ">-" ? [] : [first];
      continue;
    }
    if (key !== null && line.trim() !== "") parts.push(line.trim());
  }
  flush();
  return out;
}

function unquote(value: string): string | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function frontmatterString(fm: Record<string, unknown>, key: string): string | undefined {
  const value = fm[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Claude는 true/yes/on/1을 참으로 본다. */
export function frontmatterFlag(fm: Record<string, unknown>, key: string): boolean {
  const value = fm[key];
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());
  return false;
}

/** 본문의 첫 문단 첫 줄 (description이 없을 때 대신 쓴다) */
export function firstLine(body: string, max = 200): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return "";
}
