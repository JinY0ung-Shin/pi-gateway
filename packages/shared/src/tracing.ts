import { type Attributes, type Context, context, propagation, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";

/**
 * OpenTelemetry tracing — gateway·sandboxd·mcp-broker가 같이 쓴다.
 * - startTracing을 부르지 않으면 (JAEGER_HOST가 없는 개발·테스트) 아래 함수들은 span을 만들지 않고 fn만 실행한다.
 * - span에는 이름·시간·token 수·오류 종류만 싣는다. 프롬프트, 도구 인자·결과, 오류 메시지, 헤더 값은 싣지 않는다.
 * - 서비스 사이에는 `traceparent` 헤더로 잇는다 (traceHeaders → remoteParent).
 */

export type { Span } from "@opentelemetry/api";

const JAEGER_OTLP_PORT = 4318;
export const JAEGER_QUERY_PORT = 16686;

const tracer = () => trace.getTracer("pi-gateway");

/**
 * span을 jaegerHost의 Jaeger로 보내기 시작한다. 돌려준 함수는 남은 span을 보내고 끝낸다 (종료할 때 부른다).
 * 테스트는 exporter를 직접 준다.
 */
export function startTracing(
  service: string,
  jaegerHost: string,
  exporter: SpanExporter = new OTLPTraceExporter({ url: `http://${jaegerHost}:${JAEGER_OTLP_PORT}/v1/traces` }),
): () => Promise<void> {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
  return () => provider.shutdown();
}

/** 끝내는 것을 호출하는 쪽이 맡는 span (이벤트로 시작과 끝을 아는 경우). 지금 실행 중인 span의 자식이 된다. */
export function startSpan(name: string, attributes: Attributes = {}): Span {
  return tracer().startSpan(name, { attributes });
}

/** span을 오류로 표시한다. 오류 메시지는 싣지 않고 종류만 남긴다. */
export function failSpan(span: Span, errorType: string): void {
  span.setAttribute("error.type", errorType);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** fn을 span 안에서 실행한다. fn이 던지면 오류로 표시하고 다시 던진다. parent를 주지 않으면 지금 실행 중인 span의 자식이 된다. */
export function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, parent: Context = context.active()): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      failSpan(span, err instanceof Error ? err.name : "Error");
      throw err;
    } finally {
      span.end();
    }
  });
}

/** 지금 실행 중인 span에 값을 붙인다 (없으면 아무 일도 하지 않는다). */
export function annotateSpan(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes);
}

/** 다른 서비스로 보내는 요청에 붙일 헤더 (실행 중인 span이 없으면 빈 객체) */
export function traceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

/** 받은 요청의 헤더에서 부모 span을 꺼낸다 (withSpan의 parent로 준다). */
export function remoteParent(headers: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(ROOT_CONTEXT, headers);
}
