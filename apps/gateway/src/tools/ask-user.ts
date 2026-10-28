import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STRUCTURED_OUTPUT_TOOL } from "./structured-output.js";

/**
 * AskUserQuestion — Claude Code와 같은 입력 스키마.
 * 호출되면 바로 반환하면서 `terminate: true`로 실행을 끝낸다. gateway는 이 호출을
 * `requires_action` 응답으로 클라이언트에 넘기고, 답은 다음 요청의 사용자 메시지로 들어온다.
 * 그래서 기다리는 동안 세션을 메모리에 붙잡아 둘 필요가 없다.
 */

export const ASK_USER_TOOL = "AskUserQuestion";

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "The complete question to ask the user, ending with a question mark." }),
      header: Type.String({ description: "Very short label shown as a chip (max 12 characters)." }),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting more than one option. Default false." })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Short option text (1-5 words)." }),
          description: Type.String({ description: "What choosing this option means." }),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

export const ASK_USER_PLACEHOLDER_RESULT =
  "The question was shown to the user. Their answer will arrive as the next user message. Stop here and wait for it.";

export function createAskUserQuestionTool(): ToolDefinition<typeof AskUserQuestionParams> {
  return {
    name: ASK_USER_TOOL,
    label: "Ask user",
    description:
      "Ask the user one to four multiple-choice questions when you need their decision or missing information to continue. " +
      "The user can always answer with free text instead of an option. " +
      "Call this tool alone (not together with other tools in the same response) and end your turn after it: " +
      "the answer arrives as the next user message.",
    parameters: AskUserQuestionParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: ASK_USER_PLACEHOLDER_RESULT }],
        details: { questions: params.questions },
        terminate: true,
      };
    },
  };
}

const TURN_ENDING_TOOLS = new Set([ASK_USER_TOOL, STRUCTURED_OUTPUT_TOOL]);

/**
 * AskUserQuestion·StructuredOutput이 다른 도구와 같은 배치로 호출되면 `terminate`가 적용되지 않는다.
 * 그런 턴도 끝나도록 AgentSession의 finishTurn을 감싼다 (세션 쪽 boundary 처리는 먼저 실행).
 */
export function installTurnEndGuard(session: AgentSession): void {
  const agent = session.agent;
  const previous = agent.finishTurn;
  agent.finishTurn = async (turn, signal) => {
    const decision = await previous?.(turn, signal);
    if (turn.toolResults.some((r) => TURN_ENDING_TOOLS.has(r.toolName) && !r.isError)) return { action: "end" };
    return decision ?? undefined;
  };
}
