/**
 * 비밀처럼 생긴 글자를 가린다. LLM에 넣는 글과 LLM이 낸 글을 저장하기 전에 건다.
 * 모양으로만 찾으므로, 여기 없는 모양의 비밀은 지나간다.
 */

const MASK = "[MASKED]";
const SECRET_NAME = "(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)";

const PATTERNS: [RegExp, string][] = [
  // private key 블록 (잘려서 END가 없어도)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // scheme://user:pass@host
  [/(:\/\/[^\s/:@]+):[^\s/@]+@/g, `$1:${MASK}@`],
  // 이름=값, "이름": "값"
  [new RegExp(`([A-Za-z0-9_-]*${SECRET_NAME}["']?\\s*[=:]\\s*["']?)[^\\s"',;&]+`, "gi"), `$1${MASK}`],
  // --password 값, sshpass -p 값
  [new RegExp(`(-{1,2}[A-Za-z-]*${SECRET_NAME}\\s+|\\bsshpass\\s+-p\\s*)\\S+`, "gi"), `$1${MASK}`],
  // 긴 토큰: 숫자와 글자가 섞인 32자 이상 (hex, base64url, UUID). `/`가 없어 파일 경로는 걸리지 않는다.
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, MASK],
];

export function mask(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
