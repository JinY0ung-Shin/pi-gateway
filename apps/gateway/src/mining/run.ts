import type { Logger } from "pino";
import type { Db } from "../db.js";
import { readPath } from "../sessions/transcript.js";
import { chunks, compress } from "./compress.js";
import { EXTRACT_PROMPT, EXTRACT_TOOL, type Extracted, extractInput, toEpisodes } from "./extract.js";
import { assign, discover, merge, synthesizeFlows } from "./labels.js";
import { Caller, type Llm } from "./llm.js";
import type { MiningStore } from "./store.js";

/**
 * 한 번의 mining 실행 (docs/process-mining-design.md):
 * ① 새 내용이 있는 세션을 에피소드로 요약한다 — 세션 원문은 여기서 한 번만 읽는다.
 * ②~⑤ 에피소드에 라벨을 붙이고, 새 라벨을 찾고, 겹치는 라벨을 합치고, 라벨의 대표 흐름을 쓴다.
 */

/** 마지막 활동이 이보다 오래된 세션은 보지 않는다. 라벨을 찾을 때 보는 미분류의 기간이기도 하다. */
export const RECENT_MS = 30 * 86_400_000;
/** 마지막 활동 뒤 이만큼 지나야 본다 (진행 중인 대화를 읽지 않게) */
const IDLE_MS = 30 * 60_000;
/** 시작한 뒤 이만큼 지나면 새 LLM 호출을 보내지 않는다 */
const RUN_LIMIT_MS = 3 * 3_600_000;

export interface Target {
  id: string;
  sessionFile: string;
  leafId: string;
}

export interface Targets {
  /** 살펴볼 세션, 최근에 쓴 것부터 */
  recent: Target[];
  /** gateway에 있는 모든 세션: 세션 id → 사용자 */
  users: Map<string, string>;
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
  const all = gatewayDb.prepare("SELECT id, principal FROM sessions").all() as { id: string; principal: string }[];
  return { recent, users: new Map(all.map((r) => [r.id, r.principal])) };
}

export interface RunResult {
  status: "completed" | "time_limit" | "aborted";
  /** 끝까지 읽은 세션 수 */
  processed: number;
  /** 읽다가 실패해 다음 실행으로 넘긴 세션 수 */
  failed: number;
  /** 손대지 못했거나 읽다 만 세션 수 */
  remaining: number;
  /** 이번 실행에서 만들거나 고친 에피소드 */
  episodeIds: number[];
}

export async function run(deps: { targets: Targets; store: MiningStore; llm: Llm; log: Logger; now?: () => number }): Promise<RunResult> {
  const { targets, store, log } = deps;
  const now = deps.now ?? Date.now;
  const caller = new Caller(deps.llm, now() + RUN_LIMIT_MS, now, log);
  store.prune(targets.users);

  const pending = targets.recent.filter((t) => store.cursor(t.id) !== t.leafId);
  const touched = new Set<number>();
  let processed = 0;
  let failed = 0;

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
    }
    // 메시지가 없는 새 부분(수동 compaction 등)도 읽은 것으로 표시한다.
    store.save(target.id, [], target.leafId);
    return true;
  };

  // ① 추출
  for (const target of pending) {
    if (caller.stopped) break;
    let done = false;
    try {
      done = await mine(target);
    } catch (err) {
      log.warn({ session: target.id, err: err instanceof Error ? err.message : String(err) }, "session could not be read");
    }
    if (done) processed++;
    // 시간이 다 되어 멈춘 세션은 실패가 아니라 남은 것이다.
    else if (caller.stopped !== "time_limit") failed++;
  }

  // ②~⑤ 라벨. 앞 단계에서 멈췄으면 caller가 더 부르지 않으므로 아무 일도 하지 않고 지나간다.
  const at = new Date(now()).toISOString();
  const since = new Date(now() - RECENT_MS).toISOString();
  await assign(store, caller, at);
  const created = await discover(store, caller, targets.users, since, at);
  if (created.length > 0) await merge(store, caller, created, at, log);
  await synthesizeFlows(store, caller);

  return { status: caller.stopped ?? "completed", processed, failed, remaining: pending.length - processed - failed, episodeIds: [...touched] };
}
