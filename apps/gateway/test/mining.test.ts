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
import { merge } from "../src/mining/labels.js";
import { Caller, createLlm, type Llm } from "../src/mining/llm.js";
import { mask } from "../src/mining/mask.js";
import { plain, renderReport } from "../src/mining/report.js";
import { run, type Target } from "../src/mining/run.js";
import { MiningStore } from "../src/mining/store.js";
import { type PathEntry, readPath } from "../src/sessions/transcript.js";
import { startFakeLlm } from "./fixtures/fake-llm.js";

const dir = mkdtempSync(join(tmpdir(), "mining-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
  const targetsOf = (...recent: Target[]) => ({ recent, users: new Map(recent.map((r) => [r.id, "alice"])) });

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
    expect(store.episodes(first.episodeIds).map((e) => e.goal)).toEqual(["billing 배포", "로그 확인"]);
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
    expect(store.episodes(first.episodeIds).map((e) => e.goal)).toEqual(["billing 배포", "로그 확인 후 오류 수정"]);
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
    expect(store.episodes(result.episodeIds).map((e) => e.goal)).toEqual(["테스트 실행"]);
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
});

describe("mining: report", () => {
  it("escapes what the LLM wrote so it cannot become a link, image or table", () => {
    expect(plain("![x](http://evil/a.png) | <b>hi</b>\n# title")).toBe("\\!\\[x\\]\\(http://evil/a.png\\) \\| \\<b\\>hi\\</b\\> \\# title");
  });

  it("lists processes with counts, shows the metrics, and breaks the work down by user", () => {
    const at = new Date("2026-11-19T00:00:00.000Z");
    const episode = (id: number, sessionId: string, goal: string, labelId: number | null, endedAt = "2026-11-18T00:00:00.000Z") => ({
      id,
      sessionId,
      endedAt,
      goal,
      steps: ["확인", "수정"],
      labelId,
    });
    const recent = [
      episode(1, "s-alice", "billing 배포", 1),
      episode(2, "s-bob", "auth 배포", 1, "2026-11-01T00:00:00.000Z"),
      episode(3, "s-alice", "로그 확인", null),
      episode(4, "s-alice", "디스크 정리", null),
    ];
    const report = renderReport({
      at,
      model: "test-model",
      result: { status: "completed", processed: 2, failed: 0, remaining: 0, episodeIds: [3] },
      labels: [{ id: 1, name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", createdAt: "2026-11-17T00:00:00.000Z", flow: ["빌드", "배포", "확인"], flowCount: 2, count: 2 }],
      recent,
      touched: [recent[2]!],
      users: new Map([
        ["s-alice", "alice"],
        ["s-bob", "bob"],
      ]),
    });
    expect(report).toContain("## 최근 7일에 새로 생긴 프로세스\n\n- 서비스 배포: 서비스를 운영에 올리는 작업");
    expect(report).toContain("### 서비스 배포\n\n- 기준: 서비스를 운영에 올리는 작업\n- 건수: 7일 1건, 30일 2건\n- 사용자: 2명\n- 대표 흐름: 빌드 → 배포 → 확인\n- 예시: billing 배포\n- 예시: auth 배포");
    expect(report).toContain("- 미분류율: 50% (에피소드 4건 중 2건)");
    expect(report).toContain("- 최대 라벨 점유율: 100%");
    // 에피소드가 많은 사용자부터, 이번 실행의 에피소드는 그 사용자 아래에
    expect(report.indexOf("### alice")).toBeLessThan(report.indexOf("### bob"));
    expect(report).toContain("### alice\n\n- 최근 30일 3건: 미분류 2건, 서비스 배포 1건\n\n#### 로그 확인\n\n- 라벨: 미분류\n1. 확인\n2. 수정");
    expect(report).toContain("### bob\n\n- 최근 30일 1건: 서비스 배포 1건");
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
  const noSessions = (users: Map<string, string>) => ({ recent: [], users });

  it("finds a label from unlabeled episodes, then assigns the rest to it on the next run", async () => {
    const store = newStore();
    const users = new Map<string, string>();
    // 배포 12건(alice·bob 번갈아), carol 혼자 한 정리 6건, 그 밖의 6건
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) {
      const user = i < 12 ? (i % 2 ? "alice" : "bob") : i < 18 ? "carol" : "dave";
      users.set(`s${i}`, user);
      ids.push(seed(store, `s${i}`, i < 12 ? `서비스 ${i} 배포` : i < 18 ? `디스크 ${i} 정리` : `기타 ${i}`));
    }
    const numberOf = (user: string, goal: string) => Number(new RegExp(`\\[E(\\d+)\\] goal: ${goal}`).exec(user)![1]);

    const first = scripted({
      propose_labels: (user) => ({
        groups: [
          // 두 사람이 한 배포 6건: 채택
          { name: "서비스 배포", criteria: "서비스를 운영에 올리는 작업", episodes: [0, 1, 2, 3, 4, 5].map((i) => numberOf(user, `서비스 ${i} 배포`)) },
          // 한 사람만 한 작업: 버린다
          { name: "디스크 정리", criteria: "디스크를 비우는 작업", episodes: [12, 13, 14, 15, 16, 17].map((i) => numberOf(user, `디스크 ${i} 정리`)) },
          // 이름에 링크: 버린다
          { name: "보기 http://evil.example", criteria: "x", episodes: [6, 7, 8, 9, 10, 11].map((i) => numberOf(user, `서비스 ${i} 배포`)) },
        ],
      }),
      write_flow: () => ({ steps: ["빌드", "배포", "상태 확인"] }),
    });
    await run({ targets: noSessions(users), store, llm: first, log, now: () => NOW });
    // 라벨이 없을 때는 배정을 묻지 않는다. 새 라벨이 생겼지만 기존 라벨이 없어 병합도 묻지 않는다.
    expect(first.calls).toEqual(["propose_labels", "write_flow"]);
    const [label] = store.labels();
    expect(label).toMatchObject({ name: "서비스 배포", count: 6, flow: ["빌드", "배포", "상태 확인"], flowCount: 6 });
    // 남은 18건은 새 라벨로 다시 붙여 보도록 배정 전으로 돌아간다
    expect(store.pending()).toHaveLength(18);

    const second = scripted({
      assign_label: (user, system) => {
        expect(system).toContain(`L${label!.id}: 서비스 배포 — 서비스를 운영에 올리는 작업`);
        if (user.includes("배포")) return { label: label!.id, fit: "match" };
        // 애매하면 붙이지 않는다
        return user.includes("정리") ? { label: label!.id, fit: "unsure" } : { label: 0, fit: "none" };
      },
    });
    await run({ targets: noSessions(users), store, llm: second, log, now: () => NOW });
    // 미분류가 12건뿐이라 발견을 다시 하지 않고, 에피소드가 6건만 늘어 흐름도 다시 쓰지 않는다
    expect(second.calls).toEqual(Array(18).fill("assign_label"));
    expect(store.labels()[0]!.count).toBe(12);
    expect(store.pending()).toHaveLength(0);
    expect(store.unlabeledCount("2026-10-20T00:00:00.000Z")).toBe(12);
    expect(store.episodes(ids.slice(12)).every((e) => e.labelId === null)).toBe(true);
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
    expect(store.episodes([id])[0]!.labelId).toBe(label);
    store.save("s", [{ continues: true, startedAt: "2026-11-18T02:00:00.000Z", endedAt: "2026-11-18T03:00:00.000Z", goal: "배포 후 롤백", steps: ["배포", "롤백"] }], "e2");
    expect(store.pending().map((e) => [e.id, e.goal, e.labelId])).toEqual([[id, "배포 후 롤백", null]]);
  });
});
