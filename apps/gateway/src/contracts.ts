import type { PromptTemplate, Skill } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig, SandboxInfo, VisibleServer } from "@pi-gateway/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayModels } from "./agent/runtime.js";
import type { GatewayConfig } from "./config.js";
import type { Db } from "./db.js";
import type { SessionStore } from "./sessions/store.js";

/**
 * gateway 안의 레인 간 계약.
 *
 * - core 레인(src/agent, src/api, src/tools, src/sessions, src/sandbox, src/server.ts, src/main.ts)은
 *   아래 인터페이스를 *사용*한다.
 * - platform 레인(src/prompts, src/plugins, src/mcp-registry, src/admin, apps/admin-ui)은
 *   아래 인터페이스를 *구현*한다. 각 디렉토리의 index.ts가 factory를 export한다.
 * 시그니처를 바꿔야 하면 상대 레인과 먼저 합의한다.
 */

// ── 시스템 프롬프트 (구현: src/prompts) ─────────────────────────────

export interface PromptRenderInput {
  /** 사용자 id */
  principal: string;
  user: string;
  model: string;
  sessionId: string;
  now: Date;
}

export interface PromptSnapshot {
  /** 렌더링이 끝난 시스템 프롬프트 (pi 기본 preamble을 대체한다) */
  text: string;
  /** 어떤 배포본에서 왔는지. 기본 프롬프트면 name/version이 null이다. */
  ref: { name: string | null; version: number | null; revision: string };
}

export interface PromptService {
  /** 세션을 만들 때 한 번 호출한다. 결과는 세션 메타에 저장되고 세션을 되살릴 때 다시 쓴다. */
  snapshotForSession(input: PromptRenderInput): PromptSnapshot;
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
  /** 설치·제거·활성화가 바뀔 때마다 증가한다. */
  revision(): number;
}

// ── MCP 서버 목록 (구현: src/mcp-registry) ──────────────────────────

export interface McpRegistry {
  /** gateway DB에 있는 enabled 상태의 sandbox 실행 서버 */
  sandboxServers(): McpServerConfig[];
  /**
   * broker가 이 principal에게 허용한 서버 (broker `GET /mcp/servers`).
   * broker가 설정되지 않았거나 호출이 실패하면 빈 배열을 돌려주고 경고 로그를 남긴다.
   */
  brokerServersFor(principal: string, sessionId: string): Promise<VisibleServer[]>;
}

// ── 관리 화면 (구현: src/admin) ────────────────────────────────────

export interface SessionStats {
  liveSessions: number;
  activeTurns: number;
  queuedTurns: number;
}

export interface AdminDeps {
  config: GatewayConfig;
  db: Db;
  prompts: PromptService;
  plugins: PluginResources;
  mcp: McpRegistry;
  /** core가 제공하는 실시간 통계 */
  stats: () => SessionStats;
  /** sandboxd `GET /v1/sandboxes` */
  sandboxes: () => Promise<SandboxInfo[]>;
  /** LLM 연결 설정 (관리 화면에서 바꾸면 바로 적용된다) */
  llm: Pick<GatewayModels, "list" | "defaultModel" | "current" | "update">;
  /** 관리 화면 채팅: 관리자 로그인으로 `/v1/responses`·`…/{id}/cancel`과 같은 처리를 한다 (body.user·?user=를 믿는다) */
  chat: {
    respond: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    cancel: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /** body `{ user, model? }`로 새 세션을 열면 모델이 받는 시스템 프롬프트와 도구 */
    preview: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  };
  /** 대화 기록 보기와 보관 기간 */
  sessions: Pick<SessionStore, "list" | "get" | "retention" | "setRetention">;
}

/** `/admin`(정적 UI)과 `/admin/api/*`를 등록한다. core의 server.ts가 한 번 호출한다. */
export type RegisterAdminRoutes = (app: FastifyInstance, deps: AdminDeps) => Promise<void>;
