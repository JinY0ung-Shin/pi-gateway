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

/** 한 번에 보여 줄 턴 수 (최근 것부터) */
const MAX_TRACES = 50;
const TIMEOUT_MS = 10_000;

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

export async function sessionTraces(jaegerHost: string, sessionId: string, since: Date): Promise<TurnTrace[]> {
  const url = new URL(`http://${jaegerHost}:${JAEGER_QUERY_PORT}/api/v3/traces`);
  url.searchParams.set("query.service_name", "gateway");
  url.searchParams.set("query.attributes", JSON.stringify({ "gen_ai.conversation.id": sessionId }));
  url.searchParams.set("query.start_time_min", since.toISOString());
  url.searchParams.set("query.start_time_max", new Date().toISOString());
  url.searchParams.set("query.search_depth", String(MAX_TRACES));
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
