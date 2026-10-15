/** 관리 API 호출. 쿠키 세션을 쓰고, 상태를 바꾸는 요청에는 CSRF 헤더를 붙인다. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-admin-request"] = "1";
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/admin/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    ...(payload === undefined ? {} : { body: payload }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string; details?: unknown } } | undefined)?.error;
    if (res.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? "error", err?.details);
  }
  return data as T;
}

export const enc = encodeURIComponent;

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR", { hour12: false });
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
