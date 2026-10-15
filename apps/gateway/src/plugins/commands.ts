/**
 * Claude Code command 본문을 pi prompt template 문법으로 바꾼다.
 *
 * Claude                      pi
 *   $ARGUMENTS                  $ARGUMENTS (같음)
 *   $ARGUMENTS[N] (0부터)        $(N+1)
 *   $N (v2.1.19부터 0부터)       $(N+1)  — 본문에 $0이나 $ARGUMENTS[0]이 있을 때만.
 *                                         없으면 예전 1-based 문법으로 보고 그대로 둔다.
 *   $name (frontmatter arguments) 위치 인자로 바꾼다
 *   자리표시자가 없을 때 인자를 붙여 주는 동작 → 끝에 "ARGUMENTS: $ARGUMENTS"를 붙인다
 *   !`cmd`, ```! 블록, @file     pi에는 없다. 그대로 두고 notes에 남긴다.
 */
export interface ConvertedCommand {
  content: string;
  notes: string[];
}

const POSITIONAL = /(?<![\\$\w])\$(\d+)(?!\d)/g;
const ARGUMENTS_INDEX = /\$ARGUMENTS\[(\d+)\]/g;
const ANY_PLACEHOLDER = /\$ARGUMENTS|\$@|\$\{@|\$\{ARGUMENTS|(?<![\\$\w])\$\d/;

export function convertCommandBody(body: string, argumentNames: string[] = []): ConvertedCommand {
  const notes: string[] = [];
  let content = body;

  const zeroBased = /(?<![\\$\w])\$0(?!\d)/.test(content) || /\$ARGUMENTS\[0\]/.test(content);
  // 위치 인자를 먼저 옮긴다. $ARGUMENTS[N]을 먼저 바꾸면 그 결과가 다시 한 칸 밀린다.
  if (zeroBased) {
    content = content.replace(POSITIONAL, (_m, n: string) => `$${Number(n) + 1}`);
    notes.push("0부터 세는 $N 인자를 pi의 1부터 세는 인자로 바꿨습니다");
  }
  content = content.replace(ARGUMENTS_INDEX, (_m, n: string) => `$${Number(n) + 1}`);

  argumentNames.forEach((name, index) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    content = content.replace(new RegExp(`(?<![\\\\\\w])\\$${name}(?![\\w])`, "g"), `$${index + 1}`);
  });

  if (!ANY_PLACEHOLDER.test(content)) content = `${content.replace(/\s+$/, "")}\n\nARGUMENTS: $ARGUMENTS`;

  if (/!`[^`\n]+`/.test(content) || /^```!/m.test(content)) {
    notes.push("셸 명령 주입(!`…`)은 실행되지 않고 글자 그대로 전달됩니다");
  }
  if (/(^|\s)@[\w./-]*[\w/]/.test(content)) notes.push("@파일 참조는 자동으로 첨부되지 않습니다");
  return { content, notes };
}

/** frontmatter `arguments:` (문자열 배열, 공백 구분 문자열, {name} 배열) */
export function argumentNamesFrom(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : typeof v === "object" && v !== null && "name" in v ? String((v as { name: unknown }).name) : ""))
      .filter(Boolean);
  }
  return [];
}
