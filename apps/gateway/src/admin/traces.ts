import { JAEGER_QUERY_PORT } from "@pi-gateway/shared";
import { PlatformError } from "./errors.js";

/**
 * 세션의 trace를 Jaeger에서 읽어 관리 화면이 그릴 모양으로 바꾼다 (Jaeger의 `/api/v3/traces`, OTLP JSON).
 * 턴 하나가 trace 하나이고 (api/turn.ts의 invoke_agent span), gateway·sandboxd·mcp-broker의 span이 함께 들어 있다.
 */

export interface TraceSpan {
  id: string;
  parentId?: string;
  service: string;
  name: string;
  /** trace 시작부터의 시간 */
  startMs: number;
  durationMs: number;
  error: boolean;
  attributes: Record<string, string | number | boolean>;
}

export interface TurnTrace {
  traceId: string;
  turn?: number;
  startedAt: string;
  durationMs: number;
  spans: TraceSpan[];
}

/** 세션 하나에서 보여 줄 턴 수 (최근 것부터) */
const MAX_TRACES = 50;
/** 통계를 낼 턴 수 (최근 것부터). Jaeger에서 한 번에 읽어 메모리에서 센다. */
const MAX_STAT_TRACES = 500;
/** Jaeger의 보관 기간 (images/jaeger/config.yaml의 ttl.spans) */
const RETENTION_MS = 7 * 86_400_000;
const TIMEOUT_MS = 30_000;

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: AnyValue[] } };
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: { key: string; value: AnyValue }[];
  status?: { code?: number | string };
}
interface OtlpChunk {
  result?: { resourceSpans?: { resource?: { attributes?: { key: string; value: AnyValue }[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[] };
}

function valueOf(v: AnyValue): string | number | boolean {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return (v.arrayValue?.values ?? []).map(valueOf).join(", ");
}

const millis = (nanos: string) => Number(BigInt(nanos) / 1000n) / 1000;

/** 세션의 턴별 trace (최근 턴부터) */
export function sessionTraces(jaegerHost: string, sessionId: string, since: Date): Promise<TurnTrace[]> {
  return findTraces(jaegerHost, since, MAX_TRACES, { "query.attributes": JSON.stringify({ "gen_ai.conversation.id": sessionId }) });
}

/** since 뒤에 시작한 턴의 trace를 최근 것부터 limit개까지 읽는다. */
async function findTraces(jaegerHost: string, since: Date, limit: number, filter: Record<string, string> = {}): Promise<TurnTrace[]> {
  const url = new URL(`http://${jaegerHost}:${JAEGER_QUERY_PORT}/api/v3/traces`);
  url.searchParams.set("query.service_name", "gateway");
  url.searchParams.set("query.operation_name", "invoke_agent");
  for (const [key, value] of Object.entries(filter)) url.searchParams.set(key, value);
  url.searchParams.set("query.start_time_min", since.toISOString());
  url.searchParams.set("query.start_time_max", new Date().toISOString());
  url.searchParams.set("query.search_depth", String(limit));
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new PlatformError(503, "trace_store_unavailable", "Jaeger is unreachable");
  }
  const text = await res.text();
  // 찾은 trace가 없으면 404로 답한다
  if (res.status === 404) return [];
  if (!res.ok) throw new PlatformError(502, "trace_store_error", `Jaeger returned HTTP ${res.status}`);

  // 결과는 한 줄에 JSON 하나씩 여러 묶음으로 올 수 있다
  const byTrace = new Map<string, { span: OtlpSpan; service: string }[]>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (const rs of (JSON.parse(line) as OtlpChunk).result?.resourceSpans ?? []) {
      const service = rs.resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue ?? "";
      for (const span of (rs.scopeSpans ?? []).flatMap((s) => s.spans ?? [])) {
        let list = byTrace.get(span.traceId);
        if (!list) byTrace.set(span.traceId, (list = []));
        list.push({ span, service });
      }
    }
  }

  const traces = [...byTrace].map(([traceId, items]): TurnTrace => {
    const start = Math.min(...items.map((i) => millis(i.span.startTimeUnixNano)));
    const end = Math.max(...items.map((i) => millis(i.span.endTimeUnixNano)));
    const spans = items
      .map(({ span, service }): TraceSpan => ({
        id: span.spanId,
        ...(span.parentSpanId ? { parentId: span.parentSpanId } : {}),
        service,
        name: span.name,
        startMs: millis(span.startTimeUnixNano) - start,
        durationMs: millis(span.endTimeUnixNano) - millis(span.startTimeUnixNano),
        error: span.status?.code === 2 || span.status?.code === "STATUS_CODE_ERROR",
        attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, valueOf(a.value)])),
      }))
      .sort((a, b) => a.startMs - b.startMs);
    const turn = spans.find((s) => !s.parentId)?.attributes["pi_gateway.turn"];
    return { traceId, ...(typeof turn === "number" ? { turn } : {}), startedAt: new Date(start).toISOString(), durationMs: end - start, spans };
  });
  return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ── 통계 ─────────────────────────────────────────────────────────

interface Percentiles {
  p50: number;
  p95: number;
}

export interface TraceStats {
  /** 집계한 턴 수. limit과 같으면 그보다 오래된 턴은 빠졌다. */
  turns: number;
  limit: number;
  /** 집계한 턴 중 가장 오래된 것의 시작 시각 */
  since?: string;
  failed: number;
  turnMs: Percentiles;
  /** 턴 시작부터 첫 LLM 호출의 첫 token까지 */
  firstTokenMs: Percentiles;
  /** 턴 시간의 합을 나눈 것. other는 LLM 호출도 도구 실행도 아닌 시간 (세션 준비, 요약 등). */
  share: { llmMs: number; toolMs: number; otherMs: number };
  /** tokensPerSecond는 출력 token 합 ÷ 호출 시간 합 (첫 token을 기다린 시간 포함) */
  models: { model: string; calls: number; errors: number; firstTokenMs: Percentiles; tokensPerSecond: number }[];
  /** 턴 아래의 span을 서비스와 이름으로 묶은 것 (mcp_call은 실제로 부른 도구별), 쓴 시간이 큰 순 */
  steps: { service: string; name: string; calls: number; errors: number; totalMs: number; ms: Percentiles }[];
  slowest: { sessionId: string; turn?: number; startedAt: string; durationMs: number; error: boolean }[];
}

const SLOWEST = 10;

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.max(Math.ceil(sorted.length * p) - 1, 0)] ?? 0);
  return { p50: at(0.5), p95: at(0.95) };
}

/** span들이 덮은 시간 (동시에 돈 도구는 겹친 만큼 한 번만 센다) */
function covered(spans: TraceSpan[]): number {
  let total = 0;
  let end = 0;
  for (const s of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const stop = s.startMs + s.durationMs;
    if (stop > end) total += stop - Math.max(s.startMs, end);
    end = Math.max(end, stop);
  }
  return total;
}

/** 최근 턴들의 trace로 낸 통계: 턴 시간, 시간이 쓰인 곳, 모델별 응답 속도, 단계별 시간, 느린 턴 */
export async function traceStats(jaegerHost: string): Promise<TraceStats> {
  const traces = await findTraces(jaegerHost, new Date(Date.now() - RETENTION_MS), MAX_STAT_TRACES);
  const turnMs: number[] = [];
  const firstTokenMs: number[] = [];
  const share = { llmMs: 0, toolMs: 0, otherMs: 0 };
  const models = new Map<string, { calls: number; errors: number; firstToken: number[]; outputTokens: number; outputMs: number }>();
  const steps = new Map<string, { service: string; name: string; errors: number; ms: number[] }>();
  const slowest: TraceStats["slowest"] = [];
  let failed = 0;

  for (const t of traces) {
    const root = t.spans.find((s) => !s.parentId);
    if (!root) continue;
    turnMs.push(root.durationMs);
    if (root.error) failed++;
    const turn = root.attributes["pi_gateway.turn"];
    slowest.push({
      sessionId: String(root.attributes["gen_ai.conversation.id"] ?? ""),
      ...(typeof turn === "number" ? { turn } : {}),
      startedAt: t.startedAt,
      durationMs: Math.round(root.durationMs),
      error: root.error,
    });

    // 턴 바로 아래의 LLM 호출과 도구 실행 (하위 agent의 것은 Agent 도구 실행 안에 있다)
    const top = t.spans.filter((s) => s.parentId === root.id);
    const chats = top.filter((s) => s.name.startsWith("chat "));
    const llmMs = covered(chats);
    const toolMs = covered(top.filter((s) => s.name.startsWith("execute_tool ")));
    share.llmMs += llmMs;
    share.toolMs += toolMs;
    share.otherMs += Math.max(root.durationMs - llmMs - toolMs, 0);
    const firstToken = chats[0]?.attributes["pi_gateway.first_token_ms"];
    if (chats[0] && typeof firstToken === "number") firstTokenMs.push(chats[0].startMs - root.startMs + firstToken);

    for (const s of t.spans) {
      if (s === root) continue;
      const mcpTool = s.attributes["pi_gateway.mcp_tool"];
      const name = mcpTool ? `${s.name} ${mcpTool}` : s.name;
      const key = `${s.service} ${name}`;
      let step = steps.get(key);
      if (!step) steps.set(key, (step = { service: s.service, name, errors: 0, ms: [] }));
      step.ms.push(s.durationMs);
      if (s.error) step.errors++;

      const model = s.attributes["gen_ai.request.model"];
      if (!s.name.startsWith("chat ") || typeof model !== "string") continue;
      let m = models.get(model);
      if (!m) models.set(model, (m = { calls: 0, errors: 0, firstToken: [], outputTokens: 0, outputMs: 0 }));
      m.calls++;
      if (s.error) m.errors++;
      const first = s.attributes["pi_gateway.first_token_ms"];
      const output = s.attributes["gen_ai.usage.output_tokens"];
      if (typeof first === "number") m.firstToken.push(first);
      // 첫 token 뒤의 시간으로 나누지 않는다: 숨긴 reasoning이나 한꺼번에 오는 도구 호출은 첫 token 전에 만들어진다
      if (typeof output === "number" && output > 0) {
        m.outputTokens += output;
        m.outputMs += s.durationMs;
      }
    }
  }

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const oldest = traces.at(-1)?.startedAt;
  return {
    turns: turnMs.length,
    limit: MAX_STAT_TRACES,
    ...(oldest ? { since: oldest } : {}),
    failed,
    turnMs: percentiles(turnMs),
    firstTokenMs: percentiles(firstTokenMs),
    share: { llmMs: Math.round(share.llmMs), toolMs: Math.round(share.toolMs), otherMs: Math.round(share.otherMs) },
    models: [...models]
      .map(([model, m]) => ({ model, calls: m.calls, errors: m.errors, firstTokenMs: percentiles(m.firstToken), tokensPerSecond: m.outputMs > 0 ? Math.round(m.outputTokens / (m.outputMs / 1000)) : 0 }))
      .sort((a, b) => b.calls - a.calls),
    steps: [...steps.values()]
      .map((s) => ({ service: s.service, name: s.name, calls: s.ms.length, errors: s.errors, totalMs: Math.round(sum(s.ms)), ms: percentiles(s.ms) }))
      .sort((a, b) => b.totalMs - a.totalMs),
    slowest: slowest.sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST),
  };
}
