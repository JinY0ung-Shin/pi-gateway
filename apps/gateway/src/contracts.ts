import type { PromptTemplate, Skill } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig, SandboxInfo, VisibleServer } from "@pi-gateway/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { GatewayModels } from "./agent/runtime.js";
import type { GatewayConfig } from "./config.js";
import type { Db } from "./db.js";
import type { McpRegistryService } from "./mcp-registry/service.js";
import type { PluginService } from "./plugins/service.js";
import type { PromptManager } from "./prompts/service.js";
import type { SessionStore } from "./sessions/store.js";
import type { AdminRequests } from "./tools/request-admin.js";
import type { ToolSettings } from "./tools/settings.js";
import type { ToolStats } from "./tools/stats.js";

/**
 * 세션(src/agent, src/api, src/tools, src/sessions)이 쓰는 프롬프트·plugin·MCP 인터페이스와 관리 화면 의존성.
 * 세션 쪽은 좁은 인터페이스만 써서 테스트가 가짜로 바꿔 끼울 수 있다. 관리 화면은 실제 구현을 받는다.
 */

// ── 시스템 프롬프트 (구현: src/prompts) ─────────────────────────────

export interface PromptRenderInput {
  /** 사용자 id */
  user: string;
  model: string;
  now: Date;
}

export interface PromptService {
  /**
   * 세션을 만들 때 한 번 호출해 시스템 프롬프트를 렌더링한다 (pi 기본 preamble을 대체한다).
   * 결과는 세션 메타에 저장되고 세션을 되살릴 때 다시 쓴다.
   */
  snapshotForSession(input: PromptRenderInput): string;
}

// ── plugin 리소스 (구현: src/plugins) ──────────────────────────────

export interface SubagentDefinition {
  /** `<plugin>:<agent>` */
  name: string;
  description: string;
  /** frontmatter `tools` (Claude Code 도구 이름). 없으면 부모 세션의 도구를 모두 쓴다. */
  tools?: string[];
  /** 하위 세션의 시스템 프롬프트 (agent 본문) */
  prompt: string;
}

export interface PluginResources {
  /** 활성 plugin의 skill. filePath는 PLUGINS_DIR 아래 절대 경로이고, sandbox에서도 같은 경로로 보인다. */
  skills(): Skill[];
  /** 활성 plugin의 command를 변환한 pi prompt template. 이름은 `<plugin>:<command>`. */
  promptTemplates(): PromptTemplate[];
  /** 활성 plugin의 agent(`agents/*.md`). Agent 도구가 하위 세션으로 실행한다. */
  agents(): SubagentDefinition[];
}

// ── MCP 서버 목록 (구현: src/mcp-registry) ──────────────────────────

export interface McpRegistry {
  /** gateway DB에 있는 enabled 상태의 sandbox 실행 서버 */
  sandboxServers(): McpServerConfig[];
  /**
   * broker가 이 principal에게 허용한 서버 (broker `GET /mcp/servers`).
   * 호출이 실패하면 빈 배열을 돌려주고 경고 로그를 남긴다.
   */
  brokerServersFor(principal: string, sessionId: string): Promise<VisibleServer[]>;
  /**
   * broker JWT ctx.headers로 넘길 클라이언트 헤더 이름 (소문자): broker 서버 설정이 `{{ctx.header:NAME}}`으로 쓰는 것.
   * broker에 묻지 못하면 빈 배열을 돌려주고 경고 로그를 남긴다.
   */
  forwardHeaders(): Promise<string[]>;
}

// ── 관리 화면 (구현: src/admin) ────────────────────────────────────

export interface SessionStats {
  liveSessions: number;
  activeTurns: number;
  queuedTurns: number;
}

/** 실행 중인 턴 (관리 화면에서 멈출 수 있다) */
export interface ActiveTurn {
  user: string;
  responseId: string;
  startedAt: string;
}

export interface AdminDeps {
  config: GatewayConfig;
  db: Db;
  log: Logger;
  prompts: PromptManager;
  plugins: PluginService;
  mcp: McpRegistryService;
  /** 세션 실시간 통계 */
  stats: () => SessionStats;
  activeTurns: () => ActiveTurn[];
  /** sandboxd `GET /v1/sandboxes` */
  sandboxes: () => Promise<SandboxInfo[]>;
  /** LLM 연결 설정 (관리 화면에서 바꾸면 바로 적용된다) */
  llm: Pick<GatewayModels, "list" | "defaultModel" | "current" | "update">;
  /** 기본 도구 켜고 끄기 (메모리의 세션도 다음 턴부터 적용된다) */
  toolSettings: Pick<ToolSettings, "disabled" | "setEnabled">;
  /** 도구별 호출·턴·사용자별 토큰 통계 (최근 30일) */
  toolStats: Pick<ToolStats, "summary" | "turns" | "users">;
  /** 관리 화면 채팅: 관리자 로그인으로 `/v1/responses`·`…/{id}/cancel`과 같은 처리를 한다 (body.user·?user=를 믿는다) */
  chat: {
    respond: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    cancel: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /** body `{ user, model? }`로 새 세션을 열면 모델이 받는 시스템 프롬프트와 도구 */
    preview: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /** `GET /v1/files/content?path=&user=`와 같다 (present_file로 보여준 파일) */
    file: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /** MCP 템플릿 {{ctx.header:NAME}}로 넘어가는 헤더 (McpRegistry.forwardHeaders) */
    forwardHeaders: () => Promise<string[]>;
  };
  /** 대화 기록 보기와 보관 기간 */
  sessions: Pick<SessionStore, "list" | "get" | "retention" | "setRetention">;
  /** agent가 request_admin으로 남긴 요청 */
  adminRequests: Pick<AdminRequests, "add" | "list" | "remove">;
}
