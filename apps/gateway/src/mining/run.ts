import type { Logger } from "pino";
import type { Db } from "../db.js";
import { readPath } from "../sessions/transcript.js";
import { chunks, compress } from "./compress.js";
import { EXTRACT_PROMPT, EXTRACT_TOOL, type Extracted, extractInput, toEpisodes } from "./extract.js";
import { assign, discover, merge, review, synthesizeFlows } from "./labels.js";
import { Caller, type Llm } from "./llm.js";
import { IDLE_MS, type MiningStore, type Progress, RECENT_MS, type Stage } from "./store.js";

/**
 * 한 번의 mining 실행 (docs/process-mining-design.md):
 * ① 새 내용이 있는 세션을 에피소드로 요약한다 — 세션 원문은 여기서 한 번만 읽는다.
 * ②~⑥ 에피소드에 라벨을 붙이고, 새 라벨을 찾고, 겹치는 라벨을 합치고, 쌓인 근거로 라벨을 다시 검토하고, 대표 흐름을 쓴다.
 *    붙이고 찾기는 한 실행 안에서 몇 번 되풀이한다 (찾을 때마다 미분류에서 새로 뽑는다).
 */

/** 시작한 뒤 이만큼 지나면 새 LLM 호출을 보내지 않는다 */
const RUN_LIMIT_MS = 3 * 3_600_000;
/** 추출은 이만큼까지만 쓴다. 읽을 세션이 밀려 있어도 남은 시간에 라벨 단계가 돈다 */
const EXTRACT_LIMIT_MS = 2.5 * 3_600_000;
/** 붙이고 찾기를 한 실행에서 되풀이하는 횟수 */
const DISCOVER_ROUNDS = 3;

export interface Target {
  id: string;
  sessionFile: string;
  leafId: string;
}

export interface Targets {
  /** 살펴볼 세션, 최근에 쓴 것부터 */
  recent: Target[];
  /** gateway에 있는 모든 세션의 id */
  alive: Set<string>;
}

/** gateway DB에서 대상을 읽는다. 실행 내내 읽기 트랜잭션을 잡고 있지 않도록 시작할 때 한 번만 부른다. */
export function loadTargets(gatewayDb: Db, now = Date.now()): Targets {
  const recent = gatewayDb
    .prepare(
      `SELECT id, session_file AS sessionFile, leaf_id AS leafId FROM sessions
       WHERE session_file IS NOT NULL AND leaf_id IS NOT NULL AND last_active_at >= ? AND last_active_at < ?
       ORDER BY last_active_at DESC`,
    )
    .all(new Date(now - RECENT_MS).toISOString(), new Date(now - IDLE_MS).toISOString()) as Target[];
  const all = gatewayDb.prepare("SELECT id FROM sessions").all() as { id: string }[];
  return { recent, alive: new Set(all.map((r) => r.id)) };
}

export interface RunResult {
  /** stopped: 사람이 중지했다 */
  status: "completed" | "time_limit" | "aborted" | "stopped";
  /** 끝까지 읽은 세션 수 */
  processed: number;
  /** 읽다가 실패해 다음 실행으로 넘긴 세션 수 */
  failed: number;
  /** 손대지 못했거나 읽다 만 세션 수 */
  remaining: number;
  /** 이번 실행에서 만들거나 고친 에피소드 */
  episodeIds: number[];
}

/**
 * runId: 이 실행의 id (라벨 변경 이력에 적는다). onProgress: 단계가 바뀌거나, LLM 호출을 보내거나, 한 건을 마칠 때마다 불린다.
 * concurrency: LLM을 동시에 부르는 수 (세션 읽기, 배정, 대표 흐름. 한 세션 안의 묶음과 검토는 차례로 한다). stopRequested: 사람이 중지를 요청했는가
 */
export async function run(deps: {
  targets: Targets;
  store: MiningStore;
  llm: Llm;
  log: Logger;
  now?: () => number;
  runId?: number;
  onProgress?: (progress: Progress) => void;
  concurrency?: number;
  stopRequested?: () => boolean;
}): Promise<RunResult> {
  const { targets, store, log } = deps;
  const now = deps.now ?? Date.now;
  const runId = deps.runId ?? null;
  const started = now();
  // 호출을 보낼 때마다 진행 상황을 다시 알린다 (지금 무엇을 보냈는지가 바뀌었다)
  const limits = { concurrency: deps.concurrency, stop: deps.stopRequested, onCall: () => send() };
  const caller = new Caller(deps.llm, started + EXTRACT_LIMIT_MS, now, log, limits);
  /** 라벨 단계의 창구. 추출이 시간을 다 썼어도 남겨 둔 시간에 돈다 */
  const labeling = new Caller(deps.llm, started + RUN_LIMIT_MS, now, log, limits);
  store.prune(targets.alive);

  const pending = targets.recent.filter((t) => store.cursor(t.id) !== t.leafId);
  const touched = new Set<number>();
  let processed = 0;
  let failed = 0;
  let at: { stage: Stage; done: number; total: number } | undefined;
  const send = () =>
    at &&
    deps.onProgress?.({
      ...at,
      processed,
      failed,
      remaining: pending.length - processed - failed,
      episodes: touched.size,
      working: [...caller.working, ...labeling.working],
    });
  const report = (stage: Stage, done = 0, total = 0) => {
    at = { stage, done, total };
    send();
  };
  const tick = (stage: Stage) => (done: number, total: number) => report(stage, done, total);

  /** 세션 하나를 읽는다. 끝까지 읽었으면 true, LLM을 부르지 못해 멈췄으면 false (그때까지 읽은 묶음은 저장되어 있다). */
  const mine = async (target: Target): Promise<boolean> => {
    let path: ReturnType<typeof readPath>;
    try {
      path = readPath(target.sessionFile, target.leafId);
    } catch (err) {
      // 읽는 사이에 gateway가 지운 세션
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw err;
    }
    // leaf가 파일에 없다 (아직 다 쓰이지 않았다). 다음 실행에 다시 본다.
    if (path.length === 0) return true;
    const cursor = store.cursor(target.id);
    let start = 0;
    if (cursor) {
      const at = path.findIndex((e) => e.id === cursor);
      // 커서가 지금 경로에 없다: 메시지를 고치거나 다시 생성해 분기했다. 처음부터 다시 읽는다.
      if (at === -1) store.reset(target.id);
      else start = at + 1;
    }
    for (const chunk of chunks(compress(path.slice(start)))) {
      const end = chunk.at(-1)!.lastEntryId;
      // 도구를 쓰지 않은 대화는 작업이 아니다.
      if (!chunk.some((s) => s.tools.length > 0)) {
        store.save(target.id, [], end);
        continue;
      }
      const previous = store.lastEpisode(target.id);
      const out = await caller.call<Extracted>(EXTRACT_TOOL, EXTRACT_PROMPT, extractInput(previous, chunk), { session: target.id });
      if (!out) return false;
      for (const id of store.save(target.id, toEpisodes(chunk, out, previous !== undefined), end)) touched.add(id);
      report("extract", processed + failed, pending.length);
    }
    // 메시지가 없는 새 부분(수동 compaction 등)도 읽은 것으로 표시한다.
    store.save(target.id, [], target.leafId);
    return true;
  };

  // ① 추출 (여러 세션을 동시에)
  report("extract", 0, pending.length);
  await caller.each(pending, async (target) => {
    let done = false;
    try {
      done = await mine(target);
    } catch (err) {
      log.warn({ session: target.id, err: err instanceof Error ? err.message : String(err) }, "session could not be read");
    }
    if (done) processed++;
    // 시간이 다 됐거나 사람이 중지해서 멈춘 세션은 실패가 아니라 남은 것이다.
    else if (caller.stopped !== "time_limit" && caller.stopped !== "stopped") failed++;
    report("extract", processed + failed, pending.length);
  });

  // ②~⑥ 라벨. LLM 장애로 멈췄거나 사람이 중지했으면 하지 않는다.
  // 한 단계가 멈추면 labeling이 더 부르지 않으므로, 뒤 단계는 아무 일도 하지 않고 지나간다.
  if (caller.stopped !== "aborted" && caller.stopped !== "stopped") {
    const at = new Date(now()).toISOString();
    const since = new Date(now() - RECENT_MS).toISOString();
    // 붙이고 → 남은 미분류에서 찾기를 되풀이한다. 새 라벨이 안 생겨도 다음에는 다른 표본을 본다.
    let created: number[] = [];
    for (let round = 0; round < DISCOVER_ROUNDS; round++) {
      await assign(store, labeling, at, tick("assign"));
      report("discover");
      created = await discover(store, labeling, since, at, runId);
      if (created.length > 0) {
        report("merge");
        await merge(store, labeling, created, at, log, runId);
      }
    }
    // 고치거나 나눈 라벨의 에피소드는 새 기준으로 다시 붙인다.
    const changed = await review(store, labeling, since, at, runId, tick("review"));
    if (created.length > 0 || changed > 0) await assign(store, labeling, at, tick("reassign"));
    await synthesizeFlows(store, labeling, tick("flows"));
  }

  const stopped = (["aborted", "stopped", "time_limit"] as const).find((why) => caller.stopped === why || labeling.stopped === why);
  return { status: stopped ?? "completed", processed, failed, remaining: pending.length - processed - failed, episodeIds: [...touched] };
}
