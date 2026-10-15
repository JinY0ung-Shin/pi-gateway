/** 관리 API가 그대로 응답으로 바꾸는 오류. 응답 형식은 `{ error: { code, message, details? } }`. */
export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PlatformError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new PlatformError(400, "invalid_request", message, details);
export const notFound = (message: string) => new PlatformError(404, "not_found", message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new PlatformError(409, code, message, details);

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}
