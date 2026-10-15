import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionTool } from "../ask-user.js";
import type { ToolProvider } from "../provider.js";

/**
 * ask-user provider — AskUserQuestion. gateway 안에서 실행되는 유일한 도구이고,
 * 사용자 코드나 파일·비밀을 만지지 않는 오케스트레이션 도구라서 gateway에 둔다.
 */

export function createAskUserToolProvider(): ToolProvider {
  return {
    id: "ask-user",
    createTools: async () => [createAskUserQuestionTool() as unknown as ToolDefinition],
  };
}
