import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  type PromptTemplate,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { type RequestContext, SANDBOX_WORKSPACE, userKey } from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { PluginResources } from "../contracts.js";
import type { SandboxClient, SandboxHandle } from "../sandbox/client.js";
import type { SessionRecord } from "../sessions/store.js";
import { installAskUserTurnGuard } from "../tools/ask-user.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { GatewayModels } from "./runtime.js";

/**
 * 세션 하나의 pi AgentSession을 만든다 (새로 만들거나 JSONL에서 되살리기).
 * pi 기본 동작 중 서버에 맞지 않는 것을 모두 끈다:
 * - 디스크 탐색 없음: 직접 만든 ResourceLoader (~/.pi, 프로젝트 .pi, AGENTS.md/CLAUDE.md를 읽지 않는다)
 * - project trust 끔, cache warming 끔, 설치 텔레메트리 끔
 * - 도구는 ToolRegistry가 만든 것만 쓴다 (내장 로컬 도구는 같은 이름의 원격 도구로 대체된다)
 */

/** 세션 메타는 있는데 JSONL이 없어진 경우 (지워졌거나 볼륨이 바뀜). 만료된 세션으로 다룬다. */
export class SessionTranscriptMissingError extends Error {
  constructor(readonly sessionId: string) {
    super(`session transcript for ${sessionId} is missing`);
    this.name = "SessionTranscriptMissingError";
  }
}

export interface AgentFactoryDeps {
  config: GatewayConfig;
  models: GatewayModels;
  sandboxClient: SandboxClient;
  plugins: PluginResources;
  tools: ToolRegistry;
  log: Logger;
  /** 테스트용 pi settings 덮어쓰기 (예: retry 끄기) */
  settingsOverrides?: Record<string, unknown>;
}

export interface BuiltAgent {
  session: AgentSession;
  sandbox: SandboxHandle;
  toolNames: string[];
}

function resourceLoader(input: { systemPrompt: string; appendPrompt: string; skills: Skill[]; prompts: PromptTemplate[] }): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: input.skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: input.prompts, diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => (input.appendPrompt ? [input.appendPrompt] : []),
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function sessionDirFor(config: GatewayConfig, principal: string): string {
  return join(config.dataDir, "sessions", userKey(principal));
}

export async function buildAgentSession(
  deps: AgentFactoryDeps,
  record: SessionRecord,
  requestContext: () => RequestContext,
  signal: AbortSignal,
): Promise<BuiltAgent> {
  const model = deps.models.get(record.model);
  if (!model) throw new Error(`model ${record.model} is not configured`);
  if (record.sessionFile && record.turn > 0 && !existsSync(record.sessionFile)) throw new SessionTranscriptMissingError(record.id);
  const sandbox = deps.sandboxClient.for(record.principal, record.id);

  const { customTools, toolNames } = await deps.tools.createSessionTools({
    principal: record.principal,
    user: record.user,
    sessionId: record.id,
    model: record.model,
    sandboxClient: deps.sandboxClient,
    sandbox,
    requestContext,
    log: deps.log.child({ session: record.id }),
    signal,
  });

  const skillNames = new Set(record.skillNames);
  const skills = deps.plugins.skills().filter((s) => skillNames.has(s.name));
  const loader = resourceLoader({
    systemPrompt: record.promptText,
    appendPrompt: record.appendPrompt,
    skills,
    prompts: deps.plugins.promptTemplates(),
  });

  const sessionDir = sessionDirFor(deps.config, record.principal);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  let sessionManager: SessionManager;
  if (record.sessionFile && existsSync(record.sessionFile)) {
    sessionManager = SessionManager.open(record.sessionFile, sessionDir, SANDBOX_WORKSPACE);
    // commit되지 않은(실패·중단된) 턴의 기록은 건너뛰고 마지막 commit 지점부터 잇는다.
    if (record.turn === 0) sessionManager.resetLeaf();
    else if (record.leafId && sessionManager.getLeafId() !== record.leafId && sessionManager.getEntry(record.leafId)) {
      sessionManager.branch(record.leafId);
    }
  } else {
    sessionManager = SessionManager.create(SANDBOX_WORKSPACE, sessionDir, { id: record.id });
  }

  // pi가 agentDir 아래에 파일을 만들 일은 없지만, 홈 디렉토리 대신 gateway 데이터 아래의 빈 디렉토리를 준다.
  const agentDir = join(deps.config.dataDir, "pi-agent");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  const { session } = await createAgentSession({
    cwd: SANDBOX_WORKSPACE,
    agentDir,
    model,
    thinkingLevel: record.thinkingLevel as ThinkingLevel,
    modelRuntime: deps.models.runtime,
    resourceLoader: loader,
    tools: toolNames,
    customTools,
    sessionManager,
    settingsManager: SettingsManager.inMemory(
      {
        cacheWarming: "off",
        enableInstallTelemetry: false,
        compaction: { enabled: true },
        ...(deps.settingsOverrides ?? {}),
      },
      { projectTrusted: false },
    ),
  });
  installAskUserTurnGuard(session);
  return { session, sandbox, toolNames };
}
