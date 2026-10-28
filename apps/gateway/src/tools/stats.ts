import type { AgentSessionEvent, Skill } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { type Db, migrate } from "../db.js";
import { resolveSandboxPath } from "./remote-fs.js";

/**
 * 도구별 호출 통계 (관리 화면 상태). 호출 한 건씩은 남기지 않고 날짜(UTC)·도구별로 더한다.
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
];

const SUMMARY_DAYS = 30;

export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
}

export class ToolStats {
  constructor(private readonly db: Db) {
    migrate(db, "tool-stats", MIGRATIONS);
  }

  /**
   * 세션 하나의 이벤트 리스너. 실행된 도구 호출을 센다 (없는 도구 이름처럼 실행 전에 막힌 호출은 durationMs가 없어 빼낸다).
   * MCP 도구는 mcp_call로 불러도 결과 details의 `<server id>/<도구 이름>`으로 센다.
   * pi는 skill을 read로 불러오므로, SKILL.md를 읽은 read는 `skill/<이름>`으로 센다 (경로는 시작 이벤트에만 있다).
   */
  listener(skills: readonly Skill[]): (event: AgentSessionEvent) => void {
    const skillByFile = new Map(skills.map((s) => [s.filePath, s.name]));
    const skillReads = new Map<string, string>();
    return (event) => {
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
        .run(new Date().toISOString().slice(0, 10), tool, event.isError ? 1 : 0, Math.round(event.durationMs));
    };
  }

  /** 최근 30일, 호출이 많은 순 */
  summary(): ToolStat[] {
    const since = new Date(Date.now() - (SUMMARY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.db
      .prepare(
        `SELECT tool, SUM(calls) AS calls, SUM(errors) AS errors, CAST(ROUND(SUM(total_ms) * 1.0 / SUM(calls)) AS INTEGER) AS avgMs
         FROM tool_stats WHERE day >= ? GROUP BY tool ORDER BY calls DESC, tool`,
      )
      .all(since) as ToolStat[];
  }
}
