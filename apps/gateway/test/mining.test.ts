import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { createModelRuntime, LlmSettings, openDefaultModel } from "../src/agent/runtime.js";
import { openDatabase } from "../src/db.js";
import { chunks, compress, render } from "../src/mining/compress.js";
import { EXTRACT_PROMPT, EXTRACT_TOOL, type Extracted } from "../src/mining/extract.js";
import { merge, review } from "../src/mining/labels.js";
import { Caller, createLlm, type Llm } from "../src/mining/llm.js";
import { mask } from "../src/mining/mask.js";
import { run, type Target } from "../src/mining/run.js";
import { cameDue, MiningStore } from "../src/mining/store.js";
import { type PathEntry, readPath } from "../src/sessions/transcript.js";
import { startFakeLlm } from "./fixtures/fake-llm.js";

const dir = mkdtempSync(join(tmpdir(), "mining-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 그 id의 에피소드를 준 순서대로 */
const byIds = (store: MiningStore, ids: readonly number[]) => ids.map((id) => store.browse().find((e) => e.id === id)!);

/** 테스트용 세션 기록을 만든다. 엔트리는 앞의 것을 부모로 잇는다 (parent를 주면 거기서 분기한다). */
class Transcript {
  readonly entries: Record<string, unknown>[] = [];
  #seq = 0;
  #leaf: string | null = null;

  #add(message: Record<string, unknown>, parent?: string): string {
    const id = `e${++this.#seq}`;
    const timestamp = new Date(Date.UTC(2026, 10, 1, 0, this.#seq)).toISOString();
    this.entries.push({ type: "message", id, parentId: parent ?? this.#leaf, timestamp, message });
    this.#leaf = id;
    return id;
  }

  user(text: string, parent?: string): string {
    return this.#add({ role: "user", content: text, timestamp: 0 }, parent);
  }

  /** assistant의 도구 호출 하나와 그 결과 */
  tool(name: string, args: Record<string, unknown>, result: { isError?: boolean; details?: unknown } = {}): string {
    const callId = `c${this.#seq + 1}`;
    this.#add({ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }] });
    return this.#add({ role: "toolResult", toolCallId: callId, toolName: name, content: [], isError: result.isError ?? false, details: result.details, timestamp: 0 });
  }

  get leaf(): string {
    return this.#leaf!;
  }

  path(): PathEntry[] {
    return readPath(this.write("path"), this.leaf);
  }

  write(name: string): string {
    const file = join(dir, `${name}.jsonl`);
    const header = { type: "session", version: 3, id: name, timestamp: new Date(0).toISOString(), cwd: "/" };
    writeFileSync(file, [header, ...this.entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  }
}

describe("mining: mask", () => {
  it("hides things shaped like secrets and leaves paths and prose alone", () => {
    expect(mask("curl -H 'Authorization: Bearer abcDEF123456.xyz' https://api")).toBe("curl -H 'Authorization: Bearer [MASKED]' https://api");
    expect(mask("mysql://root:hunter2@db.internal/app")).toBe("mysql://root:[MASKED]@db.internal/app");
    expect(mask('{"DB_PASSWORD": "hunter2", "port": 5432}')).toBe('{"DB_PASSWORD": "[MASKED]", "port": 5432}');
    expect(mask("deploy --api-token s3cr3t --env prod")).toBe("deploy --api-token [MASKED] --env prod");
    expect(mask("sshpass -p hunter2 ssh ops@host")).toBe("sshpass -p [MASKED] ssh ops@host");
    expect(mask("key 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end")).toBe("key [MASKED] end");
    expect(mask("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----")).toBe("[MASKED]");
    const kept = "edit /home/app/services/billing/src/invoice/generate_monthly_report.ts then restart the token refresh job";
    expect(mask(kept)).toBe(kept);
  });
});

describe("mining: compress", () => {
  it("keeps user messages and successful tool calls, and names MCP tools and skills", () => {
    const t = new Transcript();
    t.user(`<skill name="ops:deploy" location="/opt/plugins/ops/skills/deploy/SKILL.md">\nlong body\n</skill>\n\nship billing to prod`);
    t.tool("read", { path: "/opt/plugins/ops/skills/rollback/SKILL.md" });
    t.tool("mcp_call", { name: "mcp__hex__ssh", arguments: { host: "web-1", command: "uptime" } }, { details: { server: "hex", tool: "ssh" } });
    t.tool("bash", { command: "false" }, { isError: true });
    t.tool("AskUserQuestion", { questions: [] });
    const [segment] = compress(t.path());
    expect(segment!.user).toBe("skill/ops:deploy ship billing to prod");
    expect(segment!.tools).toEqual(["skill/rollback", 'hex/ssh({"host":"web-1","command":"uptime"})']);
    expect(segment!.lastEntryId).toBe(t.leaf);
  });

  it("folds repeated calls: ×N when the arguments are the same, a spread of five when they differ", () => {
    const t = new Transcript();
    t.user("look around");
    for (let i = 0; i < 3; i++) t.tool("bash", { command: "ls" });
    for (let i = 0; i < 9; i++) t.tool("read", { path: `/src/f${i}.ts` });
    const [segment] = compress(t.path());
    expect(segment!.tools[0]).toBe('bash({"command":"ls"}) ×3');
    expect(segment!.tools.slice(1)).toEqual([
      'read({"path":"/src/f0.ts"})',
      'read({"path":"/src/f2.ts"})',
      'read({"path":"/src/f4.ts"})',
      'read({"path":"/src/f6.ts"})',
      'read({"path":"/src/f8.ts"})',
      "read … 외 4건",
    ]);
  });

  it("splits at user messages and numbers them from 1 in each chunk", () => {
    const t = new Transcript();
    for (let i = 0; i < 4; i++) {
      t.user(`task ${i}`);
      // 도구를 번갈아 불러 접히지 않게 한다
      for (let j = 0; j < 20; j++) t.tool(j % 2 ? "bash" : "grep", { command: `echo ${i} ${j} ${"x".repeat(250)}` });
    }
    const parts = chunks(compress(t.path()));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(render(part).length).toBeLessThanOrEqual(12_500);
      expect(render(part).startsWith("[U1] ")).toBe(true);
    }
    expect(parts.flat().map((s) => s.user)).toEqual(["task 0", "task 1", "task 2", "task 3"]);
  });
});

describe("mining: run", () => {
  const log = pino({ level: "silent" });
  let n = 0;
  const newStore = () => new MiningStore(openDatabase(join(dir, `mining-${++n}.db`)));
  const target = (id: string, t: Transcript): Target => ({ id, sessionFile: t.write(id), leafId: t.leaf });
  const targetsOf = (...recent: Target[]) => ({ recent, alive: new Set(recent.map((r) => r.id)) });

  /** 미리 정한 답을 차례로 돌려주는 LLM. 답이 Error면 던진다. */
  function fakeLlm(...answers: (Extracted["episodes"] | Error)[]): Llm & { inputs: string[] } {
    const inputs: string[] = [];
    return {
      model: "test-model",
      inputs,
      async call<T>(_tool: unknown, _system: string, user: string) {
        inputs.push(user);
        const answer = answers.shift();
        if (!answer) throw new Error("unexpected LLM call");
        if (answer instanceof Error) throw answer;
        return { episodes: answer } as T;
      },
    };
  }
  const episode = (goal: string, first: number, last: number, continues = false) => ({
    continues_previous: continues,
    first_message: first,
    last_message: last,
    goal,
    steps: ["로그 확인", "설정 수정"],
  });

  it("extracts episodes once, then continues the last episode when the session goes on", async () => {
    const store = newStore();
    const t = new Transcript();
    t.user("billing 서비스 배포해줘");
    t.tool("bash", { command: "make deploy" });
    t.user("이번엔 로그 좀 봐줘");
    t.tool("bash", { command: "tail app.log" });

    const llm = fakeLlm([episode("billing 배포", 1, 1), episode("로그 확인", 2, 2)]);
    const first = await run({ targets: targetsOf(target("s1", t)), store, llm, log });
    expect(first).toMatchObject({ status: "completed", processed: 1, failed: 0, remaining: 0 });
    expect(byIds(store, first.episodeIds).map((e) => e.goal)).toEqual(["billing 배포", "로그 확인"]);
    expect(store.cursor("s1")).toBe(t.leaf);

    // 바뀐 것이 없으면 LLM을 부르지 않는다
    await run({ targets: targetsOf(target("s1", t)), store, llm, log });
    expect(llm.inputs).toHaveLength(1);

    t.user("에러 난 부분도 고쳐줘");
    t.tool("bash", { command: "vim app.ts" });
    const more = fakeLlm([episode("로그 확인 후 오류 수정", 1, 1, true)]);
    const second = await run({ targets: targetsOf(target("s1", t)), store, llm: more, log });
    expect(more.inputs[0]).toContain("Previous episode:\ngoal: 로그 확인");
    expect(more.inputs[0]).not.toContain("make deploy");
    expect(second.episodeIds).toEqual([first.episodeIds[1]]);
    expect(byIds(store, first.episodeIds).map((e) => e.goal)).toEqual(["billing 배포", "로그 확인 후 오류 수정"]);
  });

  it("re-reads a session from the start when it branched away from the cursor", async () => {
    const store = newStore();
    const t = new Transcript();
    const root = t.user("배포해줘");
    t.tool("bash", { command: "make deploy" });
    await run({ targets: targetsOf(target("s2", t)), store, llm: fakeLlm([episode("배포", 1, 1)]), log });

    // 첫 메시지에서 갈라진 새 분기: 이전 leaf는 이제 경로에 없다
    t.user("테스트부터 돌려줘", root);
    t.tool("bash", { command: "make test" });
    const result = await run({ targets: targetsOf(target("s2", t)), store, llm: fakeLlm([episode("테스트 실행", 1, 2)]), log });
    expect(byIds(store, result.episodeIds).map((e) => e.goal)).toEqual(["테스트 실행"]);
    expect(store.lastEpisode("s2")!.goal).toBe("테스트 실행");
    expect(store.cursor("s2")).toBe(t.leaf);
  });

  it("does not call the LLM for talk without tools, and forgets sessions the gateway deleted", async () => {
    const store = newStore();
    const chat = new Transcript();
    chat.user("안녕");
    const work = new Transcript();
    work.user("배포해줘");
    work.tool("bash", { command: "make deploy" });
    const llm = fakeLlm([episode("배포", 1, 1)]);
    await run({ targets: targetsOf(target("chat", chat), target("work", work)), store, llm, log });
    expect(llm.inputs).toHaveLength(1);
    expect(store.cursor("chat")).toBe(chat.leaf);
    expect(store.lastEpisode("work")).toBeDefined();

    await run({ targets: targetsOf(target("chat", chat)), store, llm, log });
    expect(store.lastEpisode("work")).toBeUndefined();
    expect(store.cursor("work")).toBeUndefined();
  });

  it("stops after three failures in a row and leaves the cursors where they were", async () => {
    const store = newStore();
    const sessions = [1, 2, 3, 4].map((i) => {
      const t = new Transcript();
      t.user(`작업 ${i}`);
      t.tool("bash", { command: "ls" });
      return target(`f${i}`, t);
    });
    const down = new Error("llm_error: connect ECONNREFUSED");
    const result = await run({ targets: targetsOf(...sessions), store, llm: fakeLlm(down, down, down), log });
    expect(result).toMatchObject({ status: "aborted", processed: 0, failed: 3, remaining: 1 });
    expect(sessions.map((s) => store.cursor(s.id))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("reads several sessions at once up to the concurrency, and stops before the next call when asked to", async () => {
    const store = newStore();
    const sessions = [1, 2, 3, 4, 5].map((i) => {
      const t = new Transcript();
      t.user(`작업 ${i}`);
      t.tool("bash", { command: "ls" });
      return target(`c${i}`, t);
    });
    let calls = 0;
    let inFlight = 0;
    let most = 0;
    const llm: Llm = {
      model: "test-model",
      async call<T>() {
        calls++;
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { episodes: [episode("작업", 1, 1)] } as T;
      },
    };
    // 세 번째 호출을 보낸 뒤 사람이 중지했다: 보낸 호출은 마치고, 남은 두 세션은 읽지 않고, 라벨 단계는 하지 않는다
    const sent: string[] = [];
    const result = await run({
      targets: targetsOf(...sessions),
      store,
      llm,
      log,
      concurrency: 2,
      stopRequested: () => calls >= 3,
      onProgress: (p) => sent.push(p.working.map((w) => w.session).join("+")),
    });
    expect(most).toBe(2);
    // 호출을 보낼 때마다 지금 무엇을 보냈는지 알린다: 두 세션을 같이 읽다가, 마지막에는 하나만 남는다
    expect(sent).toContain("c1+c2");
    expect(sent.at(-1)).toBe("");
    expect(result).toMatchObject({ status: "stopped", processed: 3, failed: 0, remaining: 2 });
    expect(store.pending()).toHaveLength(3);
  });

  it("stops sending LLM calls once the time limit has passed", async () => {
    const store = newStore();
    const t = new Transcript();
    t.user("배포해줘");
    t.tool("bash", { command: "make deploy" });
    let clock = 0;
    // 부를 때마다 4시간이 지난다: 시작 뒤 첫 확인에서 이미 3시간 상한을 넘는다
    const now = () => (clock += 4 * 3_600_000);
    const result = await run({ targets: targetsOf(target("late", t)), store, llm: fakeLlm(), log, now });
    expect(result).toMatchObject({ status: "time_limit", processed: 0, remaining: 1 });
  });

  it("still runs the label stages when extraction used up its share of the time", async () => {
    const store = newStore();
    const [first, second] = [1, 2].map((i) => {
      const t = new Transcript();
      t.user(`작업 ${i}`);
      t.tool("bash", { command: "ls" });
      return target(`t${i}`, t);
    });
    // 대표 흐름이 아직 없는 라벨
    const label = store.createLabel("서비스 배포", "기준", store.save("old", [{ continues: false, startedAt: "2026-11-18T00:00:00.000Z", endedAt: "2026-11-18T01:00:00.000Z", goal: "배포", steps: ["배포"] }], "e1"), "2026-11-18T01:00:00.000Z");
    let clock = Date.UTC(2026, 10, 19);
    const calls: string[] = [];
    const llm: Llm = {
      model: "test-model",
      async call<T>(tool: { name: string }) {
        calls.push(tool.name);
        // 첫 세션을 읽는 데 2시간 40분이 걸렸다: 추출 몫(2시간 30분)은 넘고 전체 상한(3시간)은 남았다
        if (tool.name === EXTRACT_TOOL.name) clock += 160 * 60_000;
        if (tool.name === EXTRACT_TOOL.name) return { episodes: [episode("작업", 1, 1)] } as T;
        if (tool.name === "assign_label") return { label: 0, fit: "none" } as T;
        return { steps: ["빌드", "배포"] } as T;
      },
    };
    const targets = { recent: [first!, second!], alive: new Set(["t1", "t2", "old"]) };
    const result = await run({ targets, store, llm, log, now: () => clock });
    expect(result).toMatchObject({ status: "time_limit", processed: 1, remaining: 1 });
    expect(calls).toEqual([EXTRACT_TOOL.name, "assign_label", "write_flow"]);
    expect(store.labels()[0]).toMatchObject({ id: label, flow: ["빌드", "배포"] });
  });
});

describe("mining: LLM call", () => {
  it("reads the default model from a read-only gateway.db, forces the tool, and retries once on a bad answer", async () => {
    const server = await startFakeLlm();
    try {
      // gateway가 저장한 설정: 기본 모델이 티어 이름이다
      const file = join(dir, "gateway.db");
      const writable = openDatabase(file);
      const models = await createModelRuntime(writable);
      await models.update(
        LlmSettings.parse({
          servers: [{ id: "test", api: "openai-completions", baseUrl: server.url, apiKey: "", models: [{ id: "test-model", contextWindow: 32000, maxTokens: 4096 }] }],
          defaultModel: "swift",
          tiers: { swift: "test-model" },
        }),
      );
      writable.close();

      const readonly = new Database(file, { readonly: true, fileMustExist: true });
      const opened = (await openDefaultModel(readonly))!;
      readonly.close();
      expect(opened.model.id).toBe("test-model");

      const answer = { episodes: [{ continues_previous: false, first_message: 1, last_message: 1, goal: "배포", steps: ["빌드", "배포"] }] };
      server.enqueue({ text: "I will not call the tool." }, { toolCalls: [{ name: EXTRACT_TOOL.name, arguments: answer }] });
      const llm = createLlm(opened.runtime, opened.model, opened.config.maxTokens);
      expect(await llm.call<Extracted>(EXTRACT_TOOL, EXTRACT_PROMPT, "Log:\n[U1] 배포해줘")).toEqual(answer);

      expect(server.requests).toHaveLength(2);
      const request = server.requests[1]!;
      expect(request.tool_choice).toEqual({ type: "function", function: { name: EXTRACT_TOOL.name } });
      expect(request.tools!.map((t) => t.function.name)).toEqual([EXTRACT_TOOL.name]);
      expect(JSON.stringify(request.messages)).toContain("[U1] 배포해줘");

      // 두 번 다 형식이 틀리면 던진다. 오류 메시지에 모델이 쓴 글은 없다.
      server.enqueue({ text: "secret-ish model text" }, { toolCalls: [{ name: EXTRACT_TOOL.name, arguments: { episodes: "nope" } }] });
      await expect(llm.call(EXTRACT_TOOL, EXTRACT_PROMPT, "Log:\n[U1] x")).rejects.toThrow(/^invalid_output/);
    } finally {
      await server.close();
    }
  });
});

describe("mining: labels", () => {
  const log = pino({ level: "silent" });
  const NOW = Date.UTC(2026, 10, 19);
  const at = new Date(NOW).toISOString();
  let n = 0;
  const newStore = () => new MiningStore(openDatabase(join(dir, `labels-${++n}.db`)));

  /** 도구 이름별로 답을 정하는 LLM. 부른 도구를 순서대로 적어 둔다. */
  function scripted(answers: Record<string, (user: string, system: string) => unknown>): Llm & { calls: string[] } {
    const calls: string[] = [];
    return {
      model: "test-model",
      calls,
      async call<T>(tool: { name: string }, system: string, user: string) {
        calls.push(tool.name);
        const answer = answers[tool.name];
        if (!answer) throw new Error(`unexpected LLM call: ${tool.name}`);
        return answer(user, system) as T;
      },
    };
  }
  /** 세션 하나에 에피소드 하나를 넣는다. */
  const seed = (store: MiningStore, sessionId: string, goal: string) =>
    store.save(sessionId, [{ continues: false, startedAt: "2026-11-18T00:00:00.000Z", endedAt: "2026-11-18T01:00:00.000Z", goal, steps: ["로그 확인", "설정 수정"] }], "e1")[0]!;
  const noSessions = (alive: Set<string>) => ({ recent: [], alive });

  it("finds a label from unlabeled episodes, assigns the rest to it in the same run, and records the change", async () => {
    const store = newStore();
    const alive = new Set<string>();
    // 배포 12건, 정리 6건, 그 밖의 6건
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) {
      alive.add(`s${i}`);
      ids.push(seed(store, `s${i}`, i < 12 ? `서비스 ${i} 배포` : i < 18 ? `디스크 ${i} 정리` : `기타 ${i}`));
    }
    const numberOf = (user: string, goal: string) => Number(new RegExp(`\\[E(\\d+)\\] goal: ${goal}`).exec(user)![1]);
    const runId = store.requestRun("manual", at)!;
    store.startRun(at);

    const llm = scripted({
      propose_labels: (user) => ({
        groups: [
          // 배포 6건: 채택
          { name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", episodes: [0, 1, 2, 3, 4, 5].map((i) => numberOf(user, `서비스 ${i} 배포`)) },
          // 4건뿐: 버린다
          { name: "디스크 정리", criteria: "디스크를 비우는 작업", episodes: [12, 13, 14, 15].map((i) => numberOf(user, `디스크 ${i} 정리`)) },
          // 이름에 링크: 버린다
          { name: "보기 http://evil.example", criteria: "x", episodes: [6, 7, 8, 9, 10, 11].map((i) => numberOf(user, `서비스 ${i} 배포`)) },
        ],
      }),
      assign_label: (user, system) => {
        const id = store.labels()[0]!.id;
        expect(system).toContain(`L${id}: 서비스 배포 — 서비스를 운영에 올리는 작업`);
        if (user.includes("배포")) return { label: id, fit: "match" };
        // 애매하면 붙이지 않는다
        return user.includes("정리") ? { label: id, fit: "unsure" } : { label: 0, fit: "none" };
      },
      review_label: (user) => {
        // 배정된 것과, 가까웠지만 붙지 않은 것을 같이 본다
        expect(user).toContain("[E12] goal: 서비스");
        expect(user).toContain("[N6] goal: 디스크");
        return { decision: "keep", reason: "모두 서비스를 운영에 올리는 작업이다" };
      },
      write_flow: () => ({ steps: ["빌드", "배포", "상태 확인"] }),
    });
    const progress: string[] = [];
    await run({ targets: noSessions(alive), store, llm, log, now: () => NOW, runId, onProgress: (p) => progress.push(`${p.stage} ${p.done}/${p.total}`) });
    // 단계가 바뀔 때와 한 건을 마칠 때마다 진행 상황을 알린다
    expect([...new Set(progress.map((p) => p.split(" ")[0]))]).toEqual(["extract", "discover", "merge", "assign", "review", "flows"]);
    expect(progress).toContain("assign 17/18");
    // 라벨이 없을 때는 배정을 묻지 않는다. 라벨이 생기면 남은 18건을 다시 붙이고, 미분류가 12건뿐이라 더 찾지 않는다.
    // 12건이 붙은 라벨은 검토를 받는다.
    expect(llm.calls).toEqual(["propose_labels", ...Array(18).fill("assign_label"), "review_label", "write_flow"]);
    expect(store.labels()).toMatchObject([{ name: "서비스 배포", count: 12, reviewedCount: 12, near: 0, flow: ["빌드", "배포", "상태 확인"], flowCount: 12 }]);
    expect(store.pending()).toHaveLength(0);
    expect(store.unlabeledCount("2026-10-20T00:00:00.000Z")).toBe(12);
    expect(byIds(store, ids.slice(12)).every((e) => e.labelId === null)).toBe(true);
    expect(store.revisions(10)).toMatchObject([{ runId, kind: "created", name: "서비스 배포", after: "서비스 배포 — 서비스를 운영에 올리는 작업" }]);
    expect(store.runs(1)[0]!.changes).toBe(1);

    // 근거가 더 쌓이지 않았으면 다음 실행은 아무것도 묻지 않는다
    const quiet = scripted({});
    await run({ targets: noSessions(alive), store, llm: quiet, log, now: () => NOW });
    expect(quiet.calls).toEqual([]);
  });

  it("draws another sample when the first one yields no label", async () => {
    const store = newStore();
    const alive = new Set<string>();
    for (let i = 0; i < 20; i++) {
      alive.add(`s${i}`);
      seed(store, `s${i}`, i < 5 ? `서비스 ${i} 배포` : `기타 ${i}`);
    }
    let asked = 0;
    const llm = scripted({
      propose_labels: (user) =>
        ++asked === 1
          ? { groups: [] }
          : { groups: [{ name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", episodes: [...user.matchAll(/\[E(\d+)\] goal: 서비스/g)].map((m) => Number(m[1])) }] },
      assign_label: () => ({ label: 0, fit: "none" }),
      write_flow: () => ({ steps: ["빌드", "배포"] }),
    });
    await run({ targets: noSessions(alive), store, llm, log, now: () => NOW });
    // 두 번째 표본에서 라벨이 생기면 남은 15건을 다시 붙여 본다. 미분류가 15건뿐이라 세 번째는 찾지 않는다.
    expect(llm.calls).toEqual(["propose_labels", "propose_labels", ...Array(15).fill("assign_label"), "write_flow"]);
    expect(store.labels()).toMatchObject([{ name: "서비스 배포", count: 5 }]);
  });

  it("rewords a label when the review says so, and sorts its episodes again under the new criteria", async () => {
    const store = newStore();
    const alive = new Set<string>();
    const members = Array.from({ length: 10 }, (_, i) => {
      alive.add(`m${i}`);
      return seed(store, `m${i}`, `서비스 ${i} 배포`);
    });
    const label = store.createLabel("배포", "배포하는 작업", members, at);
    // 가까웠지만 붙지 않은 롤백 5건
    const near = Array.from({ length: 5 }, (_, i) => {
      alive.add(`n${i}`);
      return seed(store, `n${i}`, `서비스 ${i} 롤백`);
    });
    store.assign(near, null, at, label);

    const llm = scripted({
      review_label: () => ({ decision: "refine", name: "서비스 배포와 롤백", criteria: "서비스를 운영에 올리거나 되돌리는 작업", reason: "롤백도 같은 절차로\n한다" }),
      assign_label: (_user, system) => {
        expect(system).toContain(`L${label}: 서비스 배포와 롤백 — 서비스를 운영에 올리거나 되돌리는 작업`);
        return { label, fit: "match" };
      },
      write_flow: () => ({ steps: ["빌드", "배포", "확인"] }),
    });
    await run({ targets: noSessions(alive), store, llm, log, now: () => NOW });
    expect(llm.calls).toEqual(["review_label", ...Array(15).fill("assign_label"), "write_flow"]);
    expect(store.labels()).toMatchObject([{ id: label, name: "서비스 배포와 롤백", count: 15, reviewedCount: 10, near: 0, editedAt: null }]);
    expect(store.revisions(10)).toMatchObject([
      { runId: null, labelId: label, kind: "refined", before: "배포 — 배포하는 작업", after: "서비스 배포와 롤백 — 서비스를 운영에 올리거나 되돌리는 작업", reason: "롤백도 같은 절차로 한다" },
    ]);
  });

  it("splits a label into parts that each have enough work, and leaves it alone otherwise", async () => {
    const store = newStore();
    const seedMany = (prefix: string, goal: string) => Array.from({ length: 6 }, (_, i) => seed(store, `${prefix}${i}`, `${goal} ${i}`));
    const deploys = seedMany("d", "서비스 배포");
    const cleanups = seedMany("c", "디스크 정리");
    const mixed = store.createLabel("운영 작업", "운영에서 하는 작업", [...deploys, ...cleanups], at);
    const numbers = (user: string, goal: string) => [...user.matchAll(new RegExp(`\\[E(\\d+)\\] goal: ${goal}`, "g"))].map((m) => Number(m[1]));
    const caller = (llm: Llm) => new Caller(llm, NOW + 1, () => NOW, log);
    const since = "2026-10-20T00:00:00.000Z";

    // 한 부분만 조건을 채우면 나누지 않는다
    const lopsided = scripted({
      review_label: (user) => ({
        decision: "split",
        reason: "두 작업이 섞였다",
        parts: [
          { name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", episodes: numbers(user, "서비스 배포") },
          { name: "디스크 정리", criteria: "디스크를 비우는 작업", episodes: numbers(user, "디스크 정리").slice(0, 3) },
        ],
      }),
    });
    expect(await review(store, caller(lopsided), since, at)).toBe(0);
    expect(store.labels()).toMatchObject([{ id: mixed, count: 12, reviewedCount: 12 }]);

    // 다시 근거가 쌓인 뒤
    store.markReviewed(mixed, 0);
    const split = scripted({
      review_label: (user) => ({
        decision: "split",
        reason: "배포와 디스크 정리는 목적이 다르다",
        parts: [
          { name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", episodes: numbers(user, "서비스 배포") },
          { name: "디스크 정리", criteria: "디스크를 비우는 작업", episodes: numbers(user, "디스크 정리") },
        ],
      }),
    });
    expect(await review(store, caller(split), since, at, 7)).toBe(1);
    expect(store.labels().map((l) => [l.name, l.count])).toEqual([["서비스 배포", 6], ["디스크 정리", 6]]);
    expect(store.revisions(10).map((r) => [r.runId, r.kind, r.name, r.before, r.after, r.reason])).toEqual([
      [7, "split", "운영 작업", "운영 작업 — 운영에서 하는 작업", "서비스 배포, 디스크 정리", "배포와 디스크 정리는 목적이 다르다"],
      [7, "created", "디스크 정리", "운영 작업", "디스크 정리 — 디스크를 비우는 작업", null],
      [7, "created", "서비스 배포", "운영 작업", "서비스 배포 — 서비스를 운영에 올리는 작업", null],
    ]);
  });

  it("does not review a label a person has edited", async () => {
    const store = newStore();
    const members = Array.from({ length: 12 }, (_, i) => seed(store, `m${i}`, `배포 ${i}`));
    const label = store.createLabel("배포", "배포하는 작업", members, at);
    store.renameLabel(label, "운영 배포", "사람이 정한 기준", at);
    const llm = scripted({});
    expect(await review(store, new Caller(llm, NOW + 1, () => NOW, log), "2026-10-20T00:00:00.000Z", at)).toBe(0);
    expect(llm.calls).toEqual([]);
    expect(store.labels()).toMatchObject([{ name: "운영 배포", criteria: "사람이 정한 기준", editedAt: at }]);
  });

  it("merges a new label into the existing one it duplicates, and ignores an answer that names unknown labels", async () => {
    const store = newStore();
    const existing = store.createLabel("서비스 배포", "서비스를 운영에 올리는 작업", [seed(store, "a", "배포 1")], at);
    const fresh = store.createLabel("운영 배포", "운영 환경에 배포하는 작업", [seed(store, "b", "배포 2"), seed(store, "c", "배포 3")], at);
    const caller = (llm: Llm) => new Caller(llm, NOW + 1, () => NOW, log);

    await merge(store, caller(scripted({ merge_labels: () => ({ merges: [{ new_label: fresh, existing_label: 999 }] }) })), [fresh], at, log);
    expect(store.labels().map((l) => l.id)).toEqual([existing, fresh]);

    await merge(store, caller(scripted({ merge_labels: () => ({ merges: [{ new_label: fresh, existing_label: existing }] }) })), [fresh], at, log);
    expect(store.labels()).toMatchObject([{ id: existing, name: "서비스 배포", count: 3 }]);
  });

  it("sends an episode back to be assigned again when the session continues it", () => {
    const store = newStore();
    const id = seed(store, "s", "배포");
    const label = store.createLabel("서비스 배포", "기준", [id], at);
    expect(byIds(store, [id])[0]!.labelId).toBe(label);
    store.save("s", [{ continues: true, startedAt: "2026-11-18T02:00:00.000Z", endedAt: "2026-11-18T03:00:00.000Z", goal: "배포 후 롤백", steps: ["배포", "롤백"] }], "e2");
    expect(store.pending().map((e) => [e.id, e.goal, e.labelId])).toEqual([[id, "배포 후 롤백", null]]);
  });
});

describe("mining: runs and label edits", () => {
  const at = "2026-11-19T00:00:00.000Z";
  let n = 0;
  const newStore = () => new MiningStore(openDatabase(join(dir, `runs-${++n}.db`)));
  const seed = (store: MiningStore, sessionId: string, goal: string) =>
    store.save(sessionId, [{ continues: false, startedAt: "2026-11-18T00:00:00.000Z", endedAt: "2026-11-18T01:00:00.000Z", goal, steps: ["확인"] }], "e1")[0]!;

  it("takes one request at a time, and records how the run ended", () => {
    const store = newStore();
    expect(store.startRun(at)).toBeUndefined();
    const id = store.requestRun("manual", at)!;
    // 요청됐거나 실행 중이면 더 받지 않는다
    expect(store.requestRun("schedule", at)).toBeUndefined();
    expect(store.startRun(at)).toBe(id);
    expect(store.requestRun("manual", at)).toBeUndefined();
    store.finishRun(id, { status: "completed", processed: 3, failed: 1, remaining: 0, episodes: 4, model: "test-model" }, "2026-11-19T00:05:00.000Z");
    // 이미 끝난 실행은 다시 닫히지 않는다 (서비스가 자식 프로세스가 끝난 뒤 한 번 더 부른다)
    store.finishRun(id, { status: "failed", error: "exit 0" }, "2026-11-19T00:06:00.000Z");
    expect(store.runs(10)).toEqual([
      { id, trigger: "manual", requestedAt: at, startedAt: at, finishedAt: "2026-11-19T00:05:00.000Z", status: "completed", processed: 3, failed: 1, remaining: 0, episodes: 4, model: "test-model", error: null, stage: null, stageDone: null, stageTotal: null, progressAt: null, stopRequested: false, working: [], changes: 0 },
    ]);

    // 서비스가 내려가 실행 중으로 남은 것은 다음에 뜰 때 실패로 닫는다
    const second = store.requestRun("schedule", at)!;
    store.startRun(at);
    // 실행 중에 적은 진행 상황은 결과를 남기지 못하고 죽어도 남는다
    store.progress(second, { stage: "assign", done: 2, total: 9, processed: 4, failed: 0, remaining: 1, episodes: 6, working: [{ episode: 7 }] }, at);
    expect(store.runs(1)[0]).toMatchObject({ status: "running", stage: "assign", stageDone: 2, stageTotal: 9, processed: 4, episodes: 6, working: [{ episode: 7 }], progressAt: at });
    store.finishRun(undefined, { status: "failed", error: "내려갔다" }, at);
    expect(store.runs(1)[0]).toMatchObject({ id: second, trigger: "schedule", status: "failed", error: "내려갔다", stage: "assign", processed: 4, remaining: 1, working: [] });
  });

  it("refuses label edits while a run is in progress", () => {
    const store = newStore();
    const label = store.createLabel("서비스 배포", "기준", [seed(store, "s1", "배포")], at);
    store.requestRun("manual", at);
    // 요청만 된 동안에는 고칠 수 있다
    expect(store.edit(() => store.renameLabel(label, "운영 배포", "새 기준"))).toBe(true);
    store.startRun(at);
    expect(store.edit(() => store.deleteLabel(label))).toBe(false);
    expect(store.labels().map((l) => [l.name, l.criteria, l.count])).toEqual([["운영 배포", "새 기준", 1]]);
  });

  it("sends the episodes of a deleted label back to be assigned again, and moves them when labels are merged", () => {
    const store = newStore();
    const a = store.createLabel("배포", "기준", [seed(store, "s1", "billing 배포")], at);
    const b = store.createLabel("서비스 배포", "기준", [seed(store, "s2", "auth 배포")], at);
    const c = store.createLabel("로그 조사", "기준", [seed(store, "s3", "오류 로그 확인")], at);
    store.mergeLabels([[a, b]], at);
    expect(store.labels().map((l) => [l.id, l.count])).toEqual([[b, 2], [c, 1]]);
    expect(store.browse(b).map((e) => e.goal).sort()).toEqual(["auth 배포", "billing 배포"]);

    store.deleteLabel(b);
    expect(store.labels().map((l) => l.id)).toEqual([c]);
    expect(store.pending().map((e) => e.goal).sort()).toEqual(["auth 배포", "billing 배포"]);
    expect(store.browse(null).length).toBe(2);
  });

  it("knows when the daily time has come since the last check", () => {
    const t = (iso: string) => Date.parse(iso);
    // 18:00을 지나는 순간에만 참이다
    expect(cameDue("18:00", t("2026-11-19T17:59:55Z"), t("2026-11-19T18:00:05Z"))).toBe(true);
    expect(cameDue("18:00", t("2026-11-19T18:00:05Z"), t("2026-11-19T18:00:15Z"))).toBe(false);
    expect(cameDue("18:00", t("2026-11-19T10:00:00Z"), t("2026-11-19T10:00:10Z"))).toBe(false);
    // 자정을 넘는 구간
    expect(cameDue("23:59", t("2026-11-19T23:58:58Z"), t("2026-11-20T00:00:03Z"))).toBe(true);
    const store = newStore();
    expect(store.dailyAt()).toBeNull();
    store.setDailyAt("18:00");
    store.setDailyAt("03:30");
    expect(store.dailyAt()).toBe("03:30");
    store.setDailyAt(null);
    expect(store.dailyAt()).toBeNull();
  });
});
