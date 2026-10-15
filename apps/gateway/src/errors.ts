/**
 * oh-my-gateway와 같은 OpenAI 스타일 오류 형식.
 * 기본: `{"error": {"message", "type": "api_error", "code": "<status>"}}`
 */

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    [key: string]: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Record<string, string>;

  constructor(status: number, body: ErrorBody, headers: Record<string, string> = {}) {
    super(body.error.message);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function apiError(
  status: number,
  message: string,
  options: { type?: string; code?: string; extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
): ApiError {
  return new ApiError(
    status,
    {
      error: {
        message,
        type: options.type ?? "api_error",
        code: options.code ?? String(status),
        ...(options.extra ?? {}),
      },
    },
    options.headers ?? {},
  );
}

export const badRequest = (message: string, code?: string) =>
  apiError(400, message, code ? { type: "invalid_request_error", code } : {});
export const notFound = (message: string) => apiError(404, message);
export const conflict = (message: string) => apiError(409, message);

export const RETRY_AFTER_SECONDS = 30;

export function capacityError(): ApiError {
  return apiError(
    503,
    `Gateway is at capacity — too many agent runs in flight. Retry in ${RETRY_AFTER_SECONDS} seconds.`,
    {
      type: "server_overloaded",
      code: "concurrency_limit_exceeded",
      extra: { retry_after: RETRY_AFTER_SECONDS },
      headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
    },
  );
}

export function unauthorized(message: string): ApiError {
  return apiError(401, message, { headers: { "www-authenticate": "Bearer" } });
}

export function validationError(details: unknown): ApiError {
  return new ApiError(422, {
    error: {
      message: "Request validation failed - the request body doesn't match the expected format",
      type: "validation_error",
      code: "invalid_request_error",
      details,
    },
  });
}

export function shuttingDownError(): ApiError {
  return apiError(503, "Gateway is shutting down; retry shortly", { headers: { "retry-after": String(RETRY_AFTER_SECONDS) } });
}
