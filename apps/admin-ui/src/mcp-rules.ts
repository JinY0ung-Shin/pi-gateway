// 저장하기 전에 화면에서 바로 알려주는 MCP 설정 규칙. 서버 쪽 규칙과 같아야 한다
// (apps/gateway/test/platform/ui-rules.test.ts가 비교한다). 테스트에서도 불러오도록 다른 모듈에 의존하지 않는다.

type Transport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string | undefined }
  | { type: "http"; url: string; headers: Record<string, string> };

interface ServerLike {
  runIn: "broker" | "sandbox";
  transport: Transport;
}

// 서버 쪽 findLiteralCredentials(@pi-gateway/shared)와 같은 기준
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"]);
const CREDENTIAL_ENV = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)$/i;
const CREDENTIAL_QUERY = new Set(["token", "access_token", "api_key", "apikey", "key", "secret", "password", "auth"]);
const HAS_CREDENTIAL_REF = /\{\{\s*(secret:|ctx\.header:)/;

/** 자격증명 자리에 리터럴 값이 있는 env·header·query 이름 */
export function literalCredentials(config: ServerLike): string[] {
  const literal = (value: string) => value.trim() !== "" && !HAS_CREDENTIAL_REF.test(value);
  const out: string[] = [];
  const t = config.transport;
  if (t.type === "stdio") {
    for (const [name, value] of Object.entries(t.env)) if (CREDENTIAL_ENV.test(name) && literal(value)) out.push(name);
  } else {
    for (const [name, value] of Object.entries(t.headers)) if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && literal(value)) out.push(name);
    try {
      const url = new URL(t.url);
      if (url.username || url.password) out.push("URL의 사용자:비밀번호");
      for (const [name, value] of url.searchParams) if (CREDENTIAL_QUERY.has(name.toLowerCase()) && literal(value)) out.push(`?${name}`);
    } catch {
      // 입력 중인 URL은 형식이 맞지 않을 수 있다.
    }
  }
  return out;
}

/** broker(mcp-broker store.ts transportTarget)와 같은 기준. 이 값이 바뀌면 broker가 저장된 비밀키를 지운다. */
function transportTarget(t: Transport): string {
  const sorted = (entries: [string, string][]) => entries.sort(([a], [b]) => a.localeCompare(b));
  if (t.type === "stdio") {
    return JSON.stringify({ type: "stdio", command: t.command, args: t.args, cwd: t.cwd ?? null, env: sorted(Object.entries(t.env)) });
  }
  let origin: string;
  try {
    // host에 자리표시자가 있으면 그 자체가 행선지를 바꿀 수 있으므로 문자 그대로 비교한다
    origin = /\{\{/.test(t.url.split("/").slice(0, 3).join("/")) ? t.url : new URL(t.url).origin;
  } catch {
    origin = t.url;
  }
  const headers = sorted(Object.entries(t.headers).map(([name, value]): [string, string] => [name.toLowerCase(), value]));
  const urlSecrets = [...t.url.matchAll(/\{\{\s*secret:([A-Za-z0-9_.-]{1,64})\s*\}\}/g)].map((m) => m[1] ?? "").sort();
  return JSON.stringify({ type: "http", origin, headers, urlSecrets });
}

/**
 * broker는 서버의 실행 대상이 바뀌면 저장된 비밀키를 지운다 (다른 대상에 옛 비밀값을 보내지 않으려고).
 * 대상: http는 URL origin·헤더(이름은 대소문자 무시)·URL 안의 {{secret}} 참조, stdio는 command·args·cwd·env. runIn을 바꿔도 지워진다.
 */
export function clearsSecrets(before: ServerLike, after: ServerLike): boolean {
  return before.runIn !== after.runIn || transportTarget(before.transport) !== transportTarget(after.transport);
}
