import { type ApiErrorBody, SandboxErrorCode } from "@pi-gateway/shared";

export const HTTP_STATUS: Record<SandboxErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  is_directory: 400,
  not_directory: 400,
  too_large: 413,
  permission_denied: 403,
  sandbox_unavailable: 503,
  timeout: 504,
  internal: 500,
};

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

/** 도우미가 돌려준 code 문자열을 계약의 SandboxErrorCode로 좁힌다. */
export function toErrorCode(code: unknown): SandboxErrorCode {
  const parsed = SandboxErrorCode.safeParse(code);
  return parsed.success ? parsed.data : "internal";
}

/** Docker API 오류의 HTTP status (dockerode는 err.statusCode에 담는다) */
export function dockerStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
