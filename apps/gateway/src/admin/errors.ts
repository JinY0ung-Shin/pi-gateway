import type { z } from "zod";

/** 관리 API가 그대로 응답으로 바꾸는 오류. 응답 형식은 `{ error: { code, message } }`. */
export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;
  /** 응답 본문에는 넣지 않는다 (429의 retryAfterSeconds를 Retry-After 헤더로 보낼 때 쓴다). */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string) => new PlatformError(400, "invalid_request", message);
export const notFound = (message: string) => new PlatformError(404, "not_found", message);
export const conflict = (code: string, message: string) => new PlatformError(409, code, message);

/** zod 오류를 `<경로>: <이유>; …`로 쓴다. 경로가 없으면(최상위) root를 쓴다. */
export function issueList(error: z.ZodError, root: string): string[] {
  return error.issues.map((i) => `${i.path.join(".") || root}: ${i.message}`);
}

/** schema로 검사한 값. 맞지 않으면 400 (code, 메시지는 issueList). */
export function parseBody<T>(schema: z.ZodType<T>, input: unknown, options: { code?: string; root?: string } = {}): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PlatformError(400, options.code ?? "invalid_request", issueList(parsed.error, options.root ?? "body").join("; "));
}

/** 경고·로그에 넣는 오류 설명 (PlatformError면 code도 붙인다) */
export function describe(error: unknown): string {
  if (error instanceof PlatformError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
