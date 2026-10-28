import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, Skill } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { type Db, migrate } from "../db.js";
import { resolveSandboxPath } from "./remote-fs.js";

/**
 * 도구별 호출·턴·사용자별 토큰 통계 (관리 화면 상태). 한 건씩은 남기지 않고 날짜(UTC)별로 더한다.
 * 세션 기록은 보관 기간이 지나면 지워지므로 거기서 다시 셀 수 없다.
 */

const MIGRATIONS = [
  `CREATE TABLE tool_stats (
     day TEXT NOT NULL,
     tool TEXT NOT NULL,
     calls INTEGER NOT NULL,
     errors INTEGER NOT NULL,
     total_ms INTEGER NOT NULL,
     PRIMARY KEY (day, tool)
   )`,
  `CREATE TABLE turn_stats (
     day TEXT PRIMARY KEY,
     turns INTEGER NOT NULL,
     branched INTEGER NOT NULL
   )`,
  `CREATE TABLE user_usage (
     day TEXT NOT NULL,
     user TEXT NOT NULL,
     llm_calls INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL,
     cached_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     PRIMARY KEY (day, user)
   )`,
];

const SUMMARY_DAYS = 30;

export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
}

export interface TurnStat {
  turns: number;
  /** 예전 응답에서 갈라진 턴 (메시지 수정·재생성) */
  branched: number;
}

export interface UserUsage {
  user: string;
  llmCalls: number;
  /** 캐시 읽기·쓰기 포함 (응답 usage.input_tokens와 같다) */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const summarySince = () => new Date(Date.now() - (SUMMARY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

export class ToolStats {
  constructor(private readonly db: Db) {
    migrate(db, "tool-stats", MIGRATIONS);
  }

  /**
   * 세션 하나의 이벤트 리스너. 사용자의 LLM 호출 토큰을 더하고 (실패·중단된 턴과 하위 agent도), 실행된 도구 호출을 센다 (없는 도구 이름처럼 실행 전에 막힌 호출은 durationMs가 없어 빼낸다).
   * MCP 도구는 mcp_call로 불러도 결과 details의 `<server id>/<도구 이름>`으로 센다.
   * pi는 skill을 read로 불러오므로, SKILL.md를 읽은 read는 `skill/<이름>`으로 센다 (경로는 시작 이벤트에만 있다).
   */
  listener(user: string, skills: readonly Skill[]): (event: AgentSessionEvent) => void {
    const skillByFile = new Map(skills.map((s) => [s.filePath, s.name]));
    const skillReads = new Map<string, string>();
    return (event) => {
      if (event.type === "message_end") {
        const u = event.message.role === "assistant" ? (event.message as AssistantMessage).usage : undefined;
        if (u) this.#addUsage(user, u);
        return;
      }
      if (event.type === "tool_execution_start") {
        const path = (event.args as { path?: unknown } | undefined)?.path;
        const skill = event.toolName === "read" && typeof path === "string" ? skillByFile.get(resolveSandboxPath(path, SANDBOX_WORKSPACE)) : undefined;
        if (skill) skillReads.set(event.toolCallId, skill);
        return;
      }
      if (event.type !== "tool_execution_end") return;
      const skill = skillReads.get(event.toolCallId);
      skillReads.delete(event.toolCallId);
      if (event.durationMs === undefined) return;
      const details = (event.result as { details?: { server?: unknown; tool?: unknown } } | undefined)?.details;
      const tool = skill
        ? `skill/${skill}`
        : typeof details?.server === "string" && typeof details.tool === "string"
          ? `${details.server}/${details.tool}`
          : event.toolName;
      this.db
        .prepare(
          `INSERT INTO tool_stats (day, tool, calls, errors, total_ms) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (day, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, total_ms = total_ms + excluded.total_ms`,
        )
        .run(today(), tool, event.isError ? 1 : 0, Math.round(event.durationMs));
    };
  }

  #addUsage(user: string, u: AssistantMessage["usage"]): void {
    this.db
      .prepare(
        `INSERT INTO user_usage (day, user, llm_calls, input_tokens, cached_tokens, output_tokens) VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT (day, user) DO UPDATE SET llm_calls = llm_calls + 1, input_tokens = input_tokens + excluded.input_tokens,
           cached_tokens = cached_tokens + excluded.cached_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(today(), user, u.input + u.cacheRead + u.cacheWrite, u.cacheRead, u.output);
  }

  /** commit된 턴을 센다. branched: 최신이 아닌 응답에서 이어간 턴 */
  countTurn(branched: boolean): void {
    this.db
      .prepare(
        `INSERT INTO turn_stats (day, turns, branched) VALUES (?, 1, ?)
         ON CONFLICT (day) DO UPDATE SET turns = turns + 1, branched = branched + excluded.branched`,
      )
      .run(today(), branched ? 1 : 0);
  }

  /** 최근 30일 턴 수 */
  turns(): TurnStat {
    const row = this.db.prepare("SELECT SUM(turns) AS turns, SUM(branched) AS branched FROM turn_stats WHERE day >= ?").get(summarySince()) as {
      turns: number | null;
      branched: number | null;
    };
    return { turns: row.turns ?? 0, branched: row.branched ?? 0 };
  }

  /** 최근 30일, 호출이 많은 순 */
  summary(): ToolStat[] {
    return this.db
      .prepare(
        `SELECT tool, SUM(calls) AS calls, SUM(errors) AS errors, CAST(ROUND(SUM(total_ms) * 1.0 / SUM(calls)) AS INTEGER) AS avgMs
         FROM tool_stats WHERE day >= ? GROUP BY tool ORDER BY calls DESC, tool`,
      )
      .all(summarySince()) as ToolStat[];
  }

  /** 최근 30일 사용자별 토큰, 많이 쓴 순 */
  users(): UserUsage[] {
    return this.db
      .prepare(
        `SELECT user, SUM(llm_calls) AS llmCalls, SUM(input_tokens) AS inputTokens, SUM(cached_tokens) AS cachedTokens, SUM(output_tokens) AS outputTokens
         FROM user_usage WHERE day >= ? GROUP BY user ORDER BY inputTokens + outputTokens DESC, user`,
      )
      .all(summarySince()) as UserUsage[];
  }
}
