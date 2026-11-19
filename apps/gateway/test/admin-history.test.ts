import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.js";
import { MiningStore } from "../src/mining/store.js";
import { ALICE_KEY, BOB_KEY, type Harness, SERVICE_KEY, sessionOf, startHarness } from "./helpers.js";

const DAY = 86_400_000;

const miningDir = mkdtempSync(join(tmpdir(), "mining-admin-"));
const miningDbFile = join(miningDir, "mining.db");

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ env: { JAEGER_HOST: "jaeger.test" }, overrides: { miningDbFile } });
});
afterAll(async () => {
  await h.close();
  rmSync(miningDir, { recursive: true, force: true });
});

/** `GET /v1/responses/{id}/traces` — 기본은 alice의 키 */
const v1Traces = async (id: string, key?: string, query = "") => {
  const res = await fetch(`${h.url}/v1/responses/${id}/traces${query}`, { headers: { authorization: `Bearer ${key ?? ALICE_KEY}` } });
  return { status: res.status, json: (await res.json()) as any };
};

describe("admin mining", () => {
  it("requests a run, sets the daily time, and shows processes with their work by user", async () => {
    // 관리자 로그인이 있어야 한다
    expect((await fetch(`${h.url}/admin/api/mining`)).status).toBe(401);
    expect((await h.admin("GET", "/mining")).json).toEqual({ runs: [], dailyAt: null, labels: [], recent30: 0, unlabeled30: 0 });

    // mining 서비스가 하는 일은 같은 파일을 연 store로 흉내 낸다
    const store = new MiningStore(openDatabase(miningDbFile));
    const at = new Date().toISOString();

    const requested = await h.admin("POST", "/mining/run");
    expect(requested.status).toBe(200);
    expect((await h.admin("POST", "/mining/run")).json.error.code).toBe("mining_busy");
    expect((await h.admin("GET", "/mining")).json.runs).toMatchObject([{ id: requested.json.id, trigger: "manual", status: "requested" }]);

    expect((await h.admin("PUT", "/mining/schedule", { dailyAt: "25:00" })).json.error.code).toBe("invalid_schedule");
    expect((await h.admin("PUT", "/mining/schedule", { dailyAt: "18:00" })).json).toEqual({ dailyAt: "18:00" });
    expect(store.dailyAt()).toBe("18:00");
    expect((await h.admin("PUT", "/mining/schedule", { dailyAt: null })).json).toEqual({ dailyAt: null });

    // alice의 세션에서 나온 작업 둘 (하나는 프로세스에 들고 하나는 미분류), 지워진 세션의 작업 하나
    h.llm.enqueue({ text: "answer" });
    const sid = sessionOf((await h.post({ input: "question" })).json.id);
    const episode = (goal: string) => ({ continues: false, startedAt: at, endedAt: at, goal, steps: ["확인", "수정"] });
    const [deploy] = store.save(sid, [episode("billing 배포"), episode("로그 확인")], "e1");
    const [gone] = store.save("deleted-session", [episode("auth 배포")], "e1");
    const label = store.createLabel("서비스 배포", "서비스를 운영에 올리는 작업", [deploy!, gone!], at);
    const other = store.createLabel("로그 조사", "로그를 읽어 원인을 찾는 작업", [], at);

    const overview = (await h.admin("GET", "/mining")).json;
    expect(overview).toMatchObject({ recent30: 3, unlabeled30: 1 });
    expect(overview.labels).toMatchObject([
      { id: label, name: "서비스 배포", total: 2, recent7: 2, recent30: 2, users: 1, flow: null },
      { id: other, name: "로그 조사", total: 0, recent30: 0, users: 0 },
    ]);
    const goals = async (query: string) => ((await h.admin("GET", `/mining/episodes${query}`)).json.items as { goal: string; user: string | null }[]).map((e) => [e.goal, e.user]);
    expect((await goals(`?label=${label}`)).sort()).toEqual([["auth 배포", null], ["billing 배포", "alice"]]);
    expect(await goals("?label=none")).toEqual([["로그 확인", "alice"]]);
    expect((await goals("?user=alice")).sort()).toEqual([["billing 배포", "alice"], ["로그 확인", "alice"]]);

    // 라벨 수정: 이름·기준은 배정 프롬프트에 들어가므로 마크업을 받지 않는다
    expect((await h.admin("PUT", `/mining/labels/${label}`, { name: "[x](http://evil)", criteria: "기준" })).json.error.code).toBe("invalid_label");
    expect((await h.admin("PUT", "/mining/labels/999", { name: "이름", criteria: "기준" })).json.error.code).toBe("label_not_found");
    expect((await h.admin("PUT", `/mining/labels/${label}`, { name: "운영 배포", criteria: "새 기준" })).status).toBe(200);
    expect(store.labels()[0]).toMatchObject({ name: "운영 배포", criteria: "새 기준" });

    // 실행 중에는 고치지 못한다
    const run = store.startRun(at)!;
    expect((await h.admin("DELETE", `/mining/labels/${other}`)).json.error.code).toBe("mining_running");
    store.finishRun(run, { status: "completed", processed: 1, failed: 0, remaining: 0, episodes: 3, model: "m" }, at);

    expect((await h.admin("POST", `/mining/labels/${label}/merge`, { into: label })).json.error.code).toBe("invalid_merge");
    expect((await h.admin("POST", `/mining/labels/${label}/merge`, { into: other })).status).toBe(200);
    expect(store.labels().map((l) => [l.id, l.count])).toEqual([[other, 2]]);
    expect((await h.admin("DELETE", `/mining/labels/${other}`)).status).toBe(200);
    expect(store.labels()).toEqual([]);
    expect(store.pending().length).toBe(3);
  });
});

describe("admin history", () => {
  it("lists sessions and shows the committed transcript", async () => {
    h.llm.enqueue({ text: "first answer" });
    const first = await h.post({ input: "first question" });
    h.llm.enqueue({ text: "second answer" });
    await h.post({ input: "second question", previous_response_id: first.json.id });
    const sid = sessionOf(first.json.id);

    const list = await h.admin("GET", "/history?user=alice");
    expect(list.status).toBe(200);
    expect(list.json.items[0]).toMatchObject({ id: sid, user: "alice", turn: 2 });
    expect((await h.admin("GET", "/history?user=nobody")).json.items).toEqual([]);

    const detail = await h.admin("GET", `/history/${sid}`);
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
    expect((await h.admin("GET", "/history/nope")).status).toBe(404);
  });

  it("shows the session's traces read from Jaeger, newest turn first", async () => {
    h.llm.enqueue({ text: "hi" });
    const respId: string = (await h.post({ input: "hello" })).json.id;
    const sid = sessionOf(respId);
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
    const root = (session: string, turn: number) => [attr("gen_ai.conversation.id", { stringValue: session }), attr("pi_gateway.turn", { intValue: String(turn) })];
    const statsBody = [
      chunk("gateway", [
        span("s1", "a", "invoke_agent", 0, 1000, { attributes: root("sess-1", 1) }),
        span("s1", "b", "chat m1", 100, 500, {
          parentSpanId: "a",
          attributes: [
            attr("gen_ai.request.model", { stringValue: "m1" }),
            attr("pi_gateway.first_token_ms", { intValue: "398" }),
            attr("gen_ai.usage.output_tokens", { intValue: "70" }),
          ],
        }),
        span("s1", "c", "execute_tool bash", 500, 900, { parentSpanId: "a" }),
        span("s1", "d", "execute_tool mcp_call", 600, 900, { parentSpanId: "a", status: { code: 2 }, attributes: [attr("pi_gateway.mcp_tool", { stringValue: "srv/find" })] }),
        span("s2", "f", "invoke_agent", 5000, 7000, { status: { code: 2 }, attributes: root("sess-2", 3) }),
      ]),
      chunk("sandboxd", [span("s1", "e", "sandboxd /v1/exec", 550, 750, { parentSpanId: "c" })]),
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
      const res = await h.admin("GET", `/history/${sid}/traces`);
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
      expect((await h.admin("GET", "/history/nope/traces")).status).toBe(404);

      // 세션의 사용자는 같은 내용을 /v1에서 읽는다. 사용자 키는 ?user=를 무시하고, 서비스 키는 ?user=가 있어야 한다
      const own = await v1Traces(respId);
      expect(own.status).toBe(200);
      expect(own.json).toEqual(res.json);
      expect((await v1Traces(respId, ALICE_KEY, "?user=bob")).json).toEqual(res.json);
      expect((await v1Traces(respId, SERVICE_KEY, "?user=alice")).json).toEqual(res.json);
      expect((await v1Traces(respId, SERVICE_KEY)).status).toBe(400);
      // 다른 사용자의 응답과 없는 응답은 같은 404다
      const foreign = await v1Traces(respId, BOB_KEY, "?user=alice");
      expect(foreign.status).toBe(404);
      expect(foreign.json).toEqual({ error: { message: `Response '${respId}' not found`, type: "api_error", code: "404" } });
      expect((await v1Traces(respId, SERVICE_KEY, "?user=bob")).json).toEqual(foreign.json);
      const unknown = await v1Traces("resp_nope_1");
      expect([unknown.status, unknown.json.error.code]).toEqual([404, "404"]);
      expect((await v1Traces("nope")).status).toBe(404);

      // 통계는 세션을 가리지 않고 최근 턴을 읽는다
      stub.mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.hostname === "jaeger.test" ? new Response(statsBody) : realFetch(input, init);
      });
      const stats = (await h.admin("GET", "/traces/stats")).json;
      expect(stats).toMatchObject({
        turns: 2,
        failed: 1,
        turnMs: { p50: 1000, p95: 2000 },
        // 턴 s1: 첫 LLM 호출이 100ms에 시작해 398ms 뒤 첫 token
        firstTokenMs: { p50: 498, p95: 498 },
        // s1: LLM 100~500, 동시에 돈 도구 둘이 500~900 (겹쳐도 한 번), 나머지 200. s2: 전부 그 외 2000
        share: { llmMs: 400, toolMs: 400, otherMs: 2200 },
        // 두 턴이 5초 사이에 시작했으므로 가장 짧은 5분 칸 하나에 든다
        timeline: { stepMs: 300_000, buckets: [{ start: "2023-11-14T22:10:00.000Z", turns: 2, turnMs: { p50: 1000, p95: 2000 } }] },
        // 출력 70 token을 호출 400ms 동안 = 175 token/초 (첫 token이 끝나기 2ms 전에 와도 그 2ms로 나누지 않는다)
        models: [{ model: "m1", calls: 1, errors: 0, firstTokenMs: { p50: 398, p95: 398 }, tokensPerSecond: 175 }],
      });
      expect(stats.steps.map((s: any) => [s.service, s.name, s.calls, s.errors, s.totalMs])).toEqual([
        ["gateway", "chat m1", 1, 0, 400],
        ["gateway", "execute_tool bash", 1, 0, 400],
        ["gateway", "execute_tool mcp_call srv/find", 1, 1, 300],
        ["sandboxd", "sandboxd /v1/exec", 1, 0, 200],
      ]);
      expect(stats.slowest.map((t: any) => [t.sessionId, t.turn, t.durationMs, t.error])).toEqual([
        ["sess-2", 3, 2000, true],
        ["sess-1", 1, 1000, false],
      ]);
    } finally {
      stub.mockRestore();
    }
  });

  it("answers /v1 trace reads with the trace store's own error when Jaeger is down or fails", async () => {
    h.llm.enqueue({ text: "hi" });
    const respId: string = (await h.post({ input: "hello" })).json.id;
    const realFetch = globalThis.fetch;
    let jaeger: () => Promise<Response> = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.hostname === "jaeger.test" ? jaeger() : realFetch(input, init);
    });
    try {
      const down = await v1Traces(respId);
      expect(down.status).toBe(503);
      expect(down.json).toEqual({ error: { message: "Jaeger is unreachable", type: "api_error", code: "trace_store_unavailable" } });
      jaeger = async () => new Response("boom", { status: 500 });
      const failed = await v1Traces(respId);
      expect([failed.status, failed.json.error.code]).toEqual([502, "trace_store_error"]);
      // Jaeger에 이 세션의 trace가 없으면 (지워졌거나 아직 끝난 턴이 없다) 빈 목록이다
      jaeger = async () => new Response("{}", { status: 404 });
      expect(await v1Traces(respId)).toEqual({ status: 200, json: { traces: [] } });
    } finally {
      stub.mockRestore();
    }
  });

  it("deletes sessions past the retention period", async () => {
    expect((await h.admin("GET", "/history/retention")).json.days).toBe(0);
    expect((await h.admin("PUT", "/history/retention", { days: -1 })).status).toBe(400);
    expect((await h.admin("PUT", "/history/retention", { days: 1.5 })).status).toBe(400);

    h.llm.enqueue({ text: "bye" });
    const res = await h.post({ input: "old conversation" });
    const sid = sessionOf(res.json.id);
    const file = h.gateway.store.get(sid)!.sessionFile!;
    expect(existsSync(file)).toBe(true);

    // 0일(무기한)이면 지우지 않는다
    await h.gateway.hub.purgeExpired(Date.now() + 10 * DAY);
    expect(h.gateway.store.get(sid)).toBeDefined();

    const put = await h.admin("PUT", "/history/retention", { days: 2 });
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
