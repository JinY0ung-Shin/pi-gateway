export const REDACTED = "[REDACTED]";

/** 이보다 짧은 값은 결과를 망가뜨리지 않고 가릴 수 없어서 건너뛴다. */
const MIN_VALUE_LENGTH = 4;
/** 다른 데이터 사이에 끼어 base64로 인코딩된 조각의 최소 길이 */
const MIN_FRAGMENT_LENGTH = 6;

/**
 * 값 앞에 0~2바이트가 붙어 함께 base64로 인코딩된 경우(예: Basic 인증의 `user:pass`)에도
 * 값에서만 나오는 문자 구간을 찾는다.
 */
function base64Fragments(bytes: Buffer, encoding: "base64" | "base64url"): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/, "");
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    const fragment = encoded.slice(start, end);
    if (fragment.length >= MIN_FRAGMENT_LENGTH) out.push(fragment);
  }
  return out;
}

/** 값이 결과에 나타날 수 있는 형태들: 원문, base64(표준·url·패딩 없음·중간 조각), URL 인코딩, hex, JSON 이스케이프 */
export function secretVariants(value: string): string[] {
  if (value.length < MIN_VALUE_LENGTH) return [];
  const bytes = Buffer.from(value, "utf8");
  const variants = new Set<string>([value]);
  variants.add(bytes.toString("base64"));
  variants.add(bytes.toString("base64").replace(/=+$/, ""));
  variants.add(bytes.toString("base64url"));
  for (const f of base64Fragments(bytes, "base64")) variants.add(f);
  for (const f of base64Fragments(bytes, "base64url")) variants.add(f);
  const uri = encodeURIComponent(value);
  variants.add(uri);
  variants.add(uri.replace(/%20/g, "+"));
  variants.add(bytes.toString("hex"));
  variants.add(bytes.toString("hex").toUpperCase());
  variants.add(JSON.stringify(value).slice(1, -1));
  return [...variants].filter((v) => v.length >= MIN_VALUE_LENGTH);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 범위 안의 비밀값을 문자열과 JSON 값에서 `[REDACTED]`로 바꾼다. */
export class Redactor {
  readonly #pattern: RegExp | null;

  constructor(values: Iterable<string>) {
    const variants = new Set<string>();
    for (const value of values) for (const v of secretVariants(value)) variants.add(v);
    // 긴 형태를 먼저 맞춰야 짧은 형태가 일부만 가리는 일이 없다.
    const sorted = [...variants].sort((a, b) => b.length - a.length);
    this.#pattern = sorted.length > 0 ? new RegExp(sorted.map(escapeRegExp).join("|"), "g") : null;
  }

  get active(): boolean {
    return this.#pattern !== null;
  }

  redact(text: string): string {
    if (!this.#pattern) return text;
    return text.replace(this.#pattern, REDACTED);
  }

  /** 객체·배열을 돌며 모든 문자열(키 포함)을 가린다. 원본은 바꾸지 않는다. */
  redactDeep<T>(value: T): T {
    if (!this.#pattern) return value;
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 64) return v;
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v)) out[this.redact(k)] = walk(item, depth + 1);
        return out;
      }
      return v;
    };
    return walk(value, 0) as T;
  }
}

/** 로그에 남길 오류 문자열을 만든다. 메시지와 cause를 이어 붙이고 가린다. */
export function describeError(error: unknown, redactor: Redactor, maxLength = 2000): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return redactor.redact(parts.join(" <- ")).slice(0, maxLength);
}
