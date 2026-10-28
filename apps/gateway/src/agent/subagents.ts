import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { Type } from "typebox";
import type { SubagentDefinition } from "../contracts.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import { PRESENT_FILE_TOOL } from "../tools/present-file.js";
import { REQUEST_ADMIN_TOOL } from "../tools/request-admin.js";
import { limitToolCalls, MAX_TOOL_CALLS_PER_TURN } from "./tool-call-limit.js";

/**
 * Agent·SendMessage — plugin agent(`agents/*.md`)를 하위 pi 세션으로 실행한다.
 * - 하위 세션은 gateway 프로세스 안에서 만들고 부모 세션의 도구 정의를 그대로 쓴다. 파일·명령은 부모와
 *   같은 sandbox에서, 비밀키가 필요한 호출은 broker에서 실행되므로 격리 규칙이 그대로 지켜진다.
 * - 호출이 끝나면 하위 세션을 바로 정리한다. 기록은 JSONL로 남기고, SendMessage가 그 기록을 다시 열어 이어서 실행한다.
 * - 하위 세션에는 Agent·SendMessage·AskUserQuestion·present_file·request_admin을 주지 않는다 (깊이 1, 사용자와는 부모만 대화한다).
 */

export const AGENT_TOOL = "Agent";
export const SEND_MESSAGE_TOOL = "SendMessage";
/** 하위 세션 JSONL에 agent 종류를 남기는 custom entry */
const SUBAGENT_ENTRY = "subagent";
const AGENT_ID = /^[a-f0-9]{16}$/;

/** Claude Code 도구 이름 → gateway 도구 이름 */
const CLAUDE_TOOLS: Record<string, string[]> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  Bash: ["bash"],
  Grep: ["grep"],
  Glob: ["find", "ls"],
  LS: ["ls"],
};

export interface SubagentContext {
  agents: SubagentDefinition[];
  /** 부모 세션의 도구 */
  tools: ToolDefinition[];
  /** 하위 세션 JSONL을 두는 디렉토리 (부모 세션마다 하나) */
  dir: string;
  open(input: { systemPrompt: string; tools: ToolDefinition[]; sessionManager: SessionManager }): Promise<AgentSession>;
}

/** agent가 쓸 도구: frontmatter `tools`가 있으면 그 목록만 (모르는 이름은 무시한다) */
export function subagentTools(agent: SubagentDefinition, tools: ToolDefinition[]): ToolDefinition[] {
  const usable = tools.filter((t) => t.name !== ASK_USER_TOOL && t.name !== PRESENT_FILE_TOOL && t.name !== REQUEST_ADMIN_TOOL);
  if (!agent.tools) return usable;
  const allowed = new Set(
    agent.tools.flatMap((name) => {
      const base = name.replace(/\(.*\)$/, "").trim(); // Bash(git:*) → Bash
      return CLAUDE_TOOLS[base] ?? [base];
    }),
  );
  return usable.filter((t) => allowed.has(t.name));
}

export function createSubagentTools(ctx: SubagentContext): ToolDefinition[] {
  if (ctx.agents.length === 0) return [];
  const byName = new Map(ctx.agents.map((a) => [a.name, a]));
  /** 실행 중인 agent_id. 같은 JSONL에 두 실행이 동시에 쓰지 않게 한다. */
  const busy = new Set<string>();

  const run = async (agentId: string, agent: SubagentDefinition, sessionManager: SessionManager, text: string, signal?: AbortSignal) => {
    if (busy.has(agentId)) throw new Error(`agent '${agentId}' is still running`);
    busy.add(agentId);
    try {
      const session = await ctx.open({ systemPrompt: agent.prompt, tools: subagentTools(agent, ctx.tools), sessionManager });
      try {
        return result(agentId, await prompt(session, text, signal));
      } finally {
        session.dispose();
      }
    } finally {
      busy.delete(agentId);
    }
  };

  const agentParams = Type.Object({
    description: Type.String({ description: "A short (3-5 word) description of the task" }),
    prompt: Type.String({ description: "The task for the agent to perform" }),
    subagent_type: StringEnum(ctx.agents.map((a) => a.name), { description: "The type of agent to use" }),
  });
  const agentTool: ToolDefinition<typeof agentParams> = {
    name: AGENT_TOOL,
    label: "Agent",
    description:
      "Launch a subagent to handle a task on its own. It does not see this conversation, so put everything it needs in prompt. " +
      "It works in the same workspace and returns only its final answer, with an agent_id you can pass to " +
      `${SEND_MESSAGE_TOOL} to continue the same agent with its context.\n\nAvailable agents:\n` +
      ctx.agents.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
    parameters: agentParams,
    async execute(_toolCallId, params, signal) {
      const agent = byName.get(params.subagent_type);
      if (!agent) throw new Error(`unknown subagent_type '${params.subagent_type}'`);
      const agentId = randomBytes(8).toString("hex");
      const sessionManager = SessionManager.create(SANDBOX_WORKSPACE, ctx.dir, { id: agentId });
      sessionManager.appendCustomEntry(SUBAGENT_ENTRY, { type: agent.name });
      return run(agentId, agent, sessionManager, params.prompt, signal);
    },
  };

  const sendParams = Type.Object({
    to: Type.String({ description: `The agent_id returned by ${AGENT_TOOL}` }),
    message: Type.String({ description: "The message to send" }),
  });
  const sendTool: ToolDefinition<typeof sendParams> = {
    name: SEND_MESSAGE_TOOL,
    label: "Send message",
    description: `Send a follow-up message to a subagent started with ${AGENT_TOOL}. It continues with its previous context and returns its new final answer.`,
    parameters: sendParams,
    async execute(_toolCallId, params, signal) {
      const file = AGENT_ID.test(params.to) ? transcriptFile(ctx.dir, params.to) : undefined;
      if (!file) throw new Error(`agent '${params.to}' not found`);
      const sessionManager = SessionManager.open(file, ctx.dir, SANDBOX_WORKSPACE);
      const entry = sessionManager.getEntries().find((e) => e.type === "custom" && e.customType === SUBAGENT_ENTRY);
      const type = entry?.type === "custom" ? (entry.data as { type?: string } | undefined)?.type : undefined;
      const agent = type ? byName.get(type) : undefined;
      if (!agent) throw new Error(`agent type '${type ?? "unknown"}' is no longer available`);
      return run(params.to, agent, sessionManager, params.message, signal);
    },
  };

  return [agentTool as unknown as ToolDefinition, sendTool as unknown as ToolDefinition];
}

/** 하위 세션에 한 번 묻고 마지막 응답 텍스트를 돌려준다. 실패하면 던져서 부모가 도구 오류로 보게 한다. */
async function prompt(session: AgentSession, text: string, signal: AbortSignal | undefined): Promise<string> {
  const onAbort = () => {
    void session.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const stopLimit = limitToolCalls(session);
  let limited = false;
  try {
    if (signal?.aborted) throw new Error("aborted");
    await session.prompt(text, { expandPromptTemplates: false });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    limited = stopLimit();
  }
  if (limited) throw new Error(`subagent stopped after ${MAX_TOOL_CALLS_PER_TURN} tool calls`);
  const last = session.messages.findLast((m) => m.role === "assistant");
  if (signal?.aborted || last?.stopReason === "aborted") throw new Error("aborted");
  if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "subagent model error");
  return session.getLastAssistantText() ?? "";
}

function result(agentId: string, text: string) {
  return {
    content: [{ type: "text" as const, text: `${text || "(no output)"}\n\nagent_id: ${agentId}` }],
    details: { agentId },
  };
}

/** pi는 `<시각>_<id>.jsonl`로 저장한다. */
function transcriptFile(dir: string, agentId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((n) => n.endsWith(`_${agentId}.jsonl`));
  return name ? join(dir, name) : undefined;
}
