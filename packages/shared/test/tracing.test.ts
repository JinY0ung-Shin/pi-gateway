import { expect, it } from "vitest";
import { remoteParent, startTracing, traceHeaders, withSpan } from "../src/tracing.js";

it("links a span in another service to the caller's span through the traceparent header", async () => {
  const spans: { name: string; traceId: string; spanId: string; parentId: string | undefined; error: unknown }[] = [];
  const stop = startTracing("test", "unused", {
    export(batch, done) {
      for (const s of batch) {
        spans.push({ name: s.name, traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentId: s.parentSpanContext?.spanId, error: s.attributes["error.type"] });
      }
      done({ code: 0 });
    },
    shutdown: async () => {},
  });
  expect(traceHeaders()).toEqual({});

  let headers: Record<string, string> = {};
  await withSpan("caller", {}, async () => {
    headers = traceHeaders();
  });
  // 받는 쪽: 헤더의 span을 부모로 삼는다. 던진 오류는 종류만 남는다.
  await expect(
    withSpan("callee", {}, () => withSpan("inner", {}, async () => Promise.reject(new TypeError("secret detail"))), remoteParent(headers)),
  ).rejects.toThrow("secret detail");
  await stop();

  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  expect(byName.callee!.traceId).toBe(byName.caller!.traceId);
  expect(byName.callee!.parentId).toBe(byName.caller!.spanId);
  expect(byName.inner!.parentId).toBe(byName.callee!.spanId);
  expect(byName.inner!.error).toBe("TypeError");
  expect(JSON.stringify(spans)).not.toContain("secret detail");
});
