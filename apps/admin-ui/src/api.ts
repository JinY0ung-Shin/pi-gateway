/** 관리 API 호출. 쿠키 세션을 쓰고, 상태를 바꾸는 요청에는 CSRF 헤더를 붙인다. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-admin-request"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/admin/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | undefined)?.error;
    if (res.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code ?? "error");
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
  if (Number.isNaN(d.getTime())) return iso;
  // 표 칸에 한 줄로 들어가는 고정 폭: 2026-11-11 21:12
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 목록에서 보는 시각: 하루 안이면 "3분 전", 그보다 오래됐으면 날짜와 시각 (올해면 연도를 뺀다) */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(at)) return iso || "-";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 0 || minutes >= 24 * 60) return formatTime(iso).slice(new Date(at).getFullYear() === new Date(now).getFullYear() ? 5 : 0);
  if (minutes < 1) return "방금";
  return minutes < 60 ? `${minutes}분 전` : `${Math.floor(minutes / 60)}시간 전`;
}

/** 큰 수를 짧게: 4.1억, 310만 */
export const compact = (n: number) => new Intl.NumberFormat("ko", { notation: "compact", maximumFractionDigits: 1 }).format(n);

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

export const duration = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}시간` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}분` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`;

/** 전체가 0이면 "-" */
export const percent = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-");
