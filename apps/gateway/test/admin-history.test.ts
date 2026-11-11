import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Harness, startHarness } from "./helpers.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789";
const DAY = 86_400_000;

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { ADMIN_API_KEY: ADMIN_KEY, JAEGER_HOST: "jaeger.test" } });
});
afterAll(async () => {
  await h.close();
});

const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${h.url}/admin/api${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as any };
};

const sessionOf = (id: string) => /^resp_(.+)_\d+$/.exec(id)![1]!;

describe("admin history", () => {
  it("lists sessions and shows the committed transcript", async () => {
    h.llm.enqueue({ text: "first answer" });
    const first = await h.post({ input: "first question" });
    h.llm.enqueue({ text: "second answer" });
    await h.post({ input: "second question", previous_response_id: first.json.id });
    const sid = sessionOf(first.json.id);

    const list = await admin("GET", "/history?user=alice");
    expect(list.status).toBe(200);
    expect(list.json.items[0]).toMatchObject({ id: sid, user: "alice", turn: 2 });
    expect((await admin("GET", "/history?user=nobody")).json.items).toEqual([]);

    const detail = await admin("GET", `/history/${sid}`);
    expect(detail.status).toBe(200);
    // 처음 system 메시지가 모델이 받은 시스템 프롬프트와 도구 선언이다
    const system = detail.json.messages[0];
    expect(system.role).toBe("system");
    expect(Object.values(system.sections).join("\n")).toContain(h.prompt.text);
    expect(system.toolsAdded.map((t: any) => t.name)).toContain("bash");
    const said = detail.json.messages.filter((m: any) => m.role !== "system").map((m: any) => [m.role, JSON.stringify(m.content)]);
    expect(said.map(([role]: string[]) => role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(said[0][1]).toContain("first question");
    expect(said[3][1]).toContain("second answer");
    expect((await admin("GET", "/history/nope")).status).toBe(404);
  });

  it("shows the session's traces read from Jaeger, newest turn first", async () => {
    h.llm.enqueue({ text: "hi" });
    const sid = sessionOf((await h.post({ input: "hello" })).json.id);
    const attr = (key: string, value: object) => ({ key, value });
    const span = (traceId: string, spanId: string, name: string, startMs: number, endMs: number, extra: object = {}) => ({
      traceId,
      spanId,
      name,
      startTimeUnixNano: `${1_700_000_000_000 + startMs}000000`,
      endTimeUnixNano: `${1_700_000_000_000 + endMs}000000`,
      ...extra,
    });
    const chunk = (service: string, spans: object[]) =>
      JSON.stringify({ result: { resourceSpans: [{ resource: { attributes: [attr("service.name", { stringValue: service })] }, scopeSpans: [{ spans }] }] } });
    // Jaeger는 결과를 한 줄에 JSON 하나씩 여러 묶음으로 준다
    const body = [
      chunk("gateway", [
        span("t1", "a", "invoke_agent", 0, 500, { attributes: [attr("pi_gateway.turn", { intValue: "1" })] }),
        span("t1", "b", "execute_tool bash", 100, 400, { parentSpanId: "a", status: { code: 2 } }),
        span("t2", "d", "invoke_agent", 9000, 9100, { attributes: [attr("pi_gateway.turn", { intValue: "2" })] }),
      ]),
      chunk("sandboxd", [span("t1", "c", "sandboxd /v1/exec", 150, 350, { parentSpanId: "b" })]),
    ].join("\n");
    const realFetch = globalThis.fetch;
    let asked: URL | undefined;
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== "jaeger.test") return realFetch(input, init);
      asked = url;
      return url.searchParams.get("query.attributes")?.includes(sid) ? new Response(body) : new Response("{}", { status: 404 });
    });
    try {
      const res = await admin("GET", `/history/${sid}/traces`);
      expect(res.status).toBe(200);
      expect(asked?.port).toBe("16686");
      expect(asked?.searchParams.get("query.service_name")).toBe("gateway");
      expect(res.json.traces.map((t: any) => [t.turn, t.durationMs])).toEqual([
        [2, 100],
        [1, 500],
      ]);
      expect(res.json.traces[1].spans).toEqual([
        { id: "a", service: "gateway", name: "invoke_agent", startMs: 0, durationMs: 500, error: false, attributes: { "pi_gateway.turn": 1 } },
        { id: "b", parentId: "a", service: "gateway", name: "execute_tool bash", startMs: 100, durationMs: 300, error: true, attributes: {} },
        { id: "c", parentId: "b", service: "sandboxd", name: "sandboxd /v1/exec", startMs: 150, durationMs: 200, error: false, attributes: {} },
      ]);
      expect((await admin("GET", "/history/nope/traces")).status).toBe(404);
    } finally {
      stub.mockRestore();
    }
  });

  it("deletes sessions past the retention period", async () => {
    expect((await admin("GET", "/history/retention")).json.days).toBe(0);
    expect((await admin("PUT", "/history/retention", { days: -1 })).status).toBe(400);
    expect((await admin("PUT", "/history/retention", { days: 1.5 })).status).toBe(400);

    h.llm.enqueue({ text: "bye" });
    const res = await h.post({ input: "old conversation" });
    const sid = sessionOf(res.json.id);
    const file = h.gateway.store.get(sid)!.sessionFile!;
    expect(existsSync(file)).toBe(true);

    // 0일(무기한)이면 지우지 않는다
    await h.gateway.hub.purgeExpired(Date.now() + 10 * DAY);
    expect(h.gateway.store.get(sid)).toBeDefined();

    const put = await admin("PUT", "/history/retention", { days: 2 });
    expect(put.json).toMatchObject({ days: 2, updatedAt: expect.any(String) });
    await h.gateway.hub.purgeExpired(Date.now() + 1 * DAY);
    expect(h.gateway.store.get(sid)).toBeDefined();
    await h.gateway.hub.purgeExpired(Date.now() + 3 * DAY);
    expect(h.gateway.store.get(sid)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(h.gateway.hub.get(sid)).toBeUndefined();
    expect((await h.post({ input: "again", previous_response_id: res.json.id })).status).toBe(404);
  });
});
