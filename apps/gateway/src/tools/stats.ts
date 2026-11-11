import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, Skill } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { type Db, migrate } from "../db.js";
import { MCP_SEARCH_TOOL, type McpSearchDetails } from "../mcp-client/proxy.js";
import { resolveSandboxPath } from "./remote-fs.js";

/**
 * 도구별 호출·턴·사용자별 토큰·mcp_search 정확도 통계 (관리 화면 상태). 한 건씩은 남기지 않고 날짜(UTC)별로 더한다.
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
  `CREATE TABLE search_stats (
     day TEXT NOT NULL,
     method TEXT NOT NULL,
     searches INTEGER NOT NULL,
     called INTEGER NOT NULL,
     top1 INTEGER NOT NULL,
     top2 INTEGER NOT NULL,
     top3 INTEGER NOT NULL,
     PRIMARY KEY (day, method)
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

/**
 * mcp_search의 정확도. 정답은 알 수 없어서, 검색 뒤 같은 실행에서 처음 부른 MCP 도구가 검색 결과의 몇 번째였는지로 본다.
 */
export interface SearchStat {
  method: McpSearchDetails["search"]["method"];
  searches: number;
  /** 다음 검색 전에 MCP 도구 호출로 이어진 검색 */
  called: number;
  /** 그중 부른 도구가 결과의 1·2·3번째 안에 있던 검색 (누적) */
  top1: number;
  top2: number;
  top3: number;
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
   * mcp_search 뒤에 처음 실행된 MCP 도구가 그 검색 결과의 몇 번째였는지도 센다 (실행이 새로 시작되면 이전 검색은 잊는다).
   */
  listener(user: string, skills: readonly Skill[]): (event: AgentSessionEvent) => void {
    const skillByFile = new Map(skills.map((s) => [s.filePath, s.name]));
    const skillReads = new Map<string, string>();
    let search: McpSearchDetails["search"] | undefined;
    return (event) => {
      if (event.type === "agent_start") {
        search = undefined;
        return;
      }
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
      const details = (event.result as { details?: { server?: unknown; tool?: unknown } & Partial<McpSearchDetails> } | undefined)?.details;
      const mcpTool = typeof details?.server === "string" && typeof details.tool === "string" ? `${details.server}/${details.tool}` : undefined;
      const tool = skill ? `skill/${skill}` : (mcpTool ?? event.toolName);
      if (event.toolName === MCP_SEARCH_TOOL && details?.search) {
        search = details.search;
        this.#addSearch(search.method, 1, undefined);
      } else if (search && mcpTool) {
        this.#addSearch(search.method, 0, search.tools.indexOf(mcpTool) + 1);
        search = undefined;
      }
      this.db
        .prepare(
          `INSERT INTO tool_stats (day, tool, calls, errors, total_ms) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (day, tool) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, total_ms = total_ms + excluded.total_ms`,
        )
        .run(today(), tool, event.isError ? 1 : 0, Math.round(event.durationMs));
    };
  }

  /** rank: 검색 뒤에 부른 도구의 순위 (1부터, 결과에 없으면 0). undefined면 검색만 센다. */
  #addSearch(method: string, searches: number, rank: number | undefined): void {
    const within = (k: number) => (rank !== undefined && rank >= 1 && rank <= k ? 1 : 0);
    this.db
      .prepare(
        `INSERT INTO search_stats (day, method, searches, called, top1, top2, top3) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, method) DO UPDATE SET searches = searches + excluded.searches, called = called + excluded.called,
           top1 = top1 + excluded.top1, top2 = top2 + excluded.top2, top3 = top3 + excluded.top3`,
      )
      .run(today(), method, searches, rank === undefined ? 0 : 1, within(1), within(2), within(3));
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

  /** 최근 30일 mcp_search 정확도, 검색 방식별 */
  searches(): SearchStat[] {
    return this.db
      .prepare(
        `SELECT method, SUM(searches) AS searches, SUM(called) AS called, SUM(top1) AS top1, SUM(top2) AS top2, SUM(top3) AS top3
         FROM search_stats WHERE day >= ? GROUP BY method ORDER BY method DESC`,
      )
      .all(summarySince()) as SearchStat[];
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
