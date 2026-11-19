import type { Logger } from "pino";
import type { Db } from "../db.js";
import { readPath } from "../sessions/transcript.js";
import { chunks, compress } from "./compress.js";
import { EXTRACT_PROMPT, EXTRACT_TOOL, type Extracted, extractInput, toEpisodes } from "./extract.js";
import type { Llm } from "./llm.js";
import type { MiningStore } from "./store.js";

/**
 * 한 번의 mining 실행: 새 내용이 있는 세션을 골라 에피소드로 요약한다 (docs/process-mining-design.md).
 * 세션 원문은 여기서 한 번만 읽는다.
 */

/** 마지막 활동이 이보다 오래된 세션은 보지 않는다 */
const RECENT_MS = 30 * 86_400_000;
/** 마지막 활동 뒤 이만큼 지나야 본다 (진행 중인 대화를 읽지 않게) */
const IDLE_MS = 30 * 60_000;
/** 시작한 뒤 이만큼 지나면 새 LLM 호출을 보내지 않는다 */
const RUN_LIMIT_MS = 3 * 3_600_000;
/** LLM 호출이 이만큼 연달아 실패하면 끝낸다 (LLM 서버 장애) */
const MAX_CONSECUTIVE_FAILURES = 3;

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
  /** LLM 호출이 실패해 다음 실행으로 넘긴 세션 수 */
  failed: number;
  /** 손대지 못한 세션 수 */
  remaining: number;
  /** 이번 실행에서 만들거나 고친 에피소드 */
  episodeIds: number[];
}

export async function run(deps: { targets: Targets; store: MiningStore; llm: Llm; log: Logger; now?: () => number }): Promise<RunResult> {
  const { targets, store, llm, log } = deps;
  const now = deps.now ?? Date.now;
  const deadline = now() + RUN_LIMIT_MS;
  store.prune(targets.users);

  const pending = targets.recent.filter((t) => store.cursor(t.id) !== t.leafId);
  const result: RunResult = { status: "completed", processed: 0, failed: 0, remaining: pending.length, episodeIds: [] };
  const touched = new Set<number>();
  let consecutiveFailures = 0;

  /** 세션 하나. LLM 호출이 실패하면 던진다 (그때까지 읽은 묶음은 저장되어 있다). 시간이 다 되면 false. */
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
      if (now() >= deadline) return false;
      const previous = store.lastEpisode(target.id);
      const out = await llm.call<Extracted>(EXTRACT_TOOL, EXTRACT_PROMPT, extractInput(previous, chunk));
      consecutiveFailures = 0;
      for (const id of store.save(target.id, toEpisodes(chunk, out, previous !== undefined), end)) touched.add(id);
    }
    // 메시지가 없는 새 부분(수동 compaction 등)도 읽은 것으로 표시한다.
    store.save(target.id, [], target.leafId);
    return true;
  };

  for (const target of pending) {
    try {
      if (!(await mine(target))) {
        result.status = "time_limit";
        break;
      }
      result.processed++;
    } catch (err) {
      result.failed++;
      consecutiveFailures++;
      log.warn({ session: target.id, err: err instanceof Error ? err.message : String(err) }, "session skipped");
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        result.status = "aborted";
        result.remaining--;
        break;
      }
    }
    result.remaining--;
  }
  result.episodeIds = [...touched];
  return result;
}
