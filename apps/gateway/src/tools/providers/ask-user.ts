import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCatalogEntry } from "../../contracts.js";
import { ASK_USER_TOOL, createAskUserQuestionTool } from "../ask-user.js";
import { staticEntryLookup, type ToolProvider } from "../provider.js";

/**
 * ask-user provider — AskUserQuestion. gateway 안에서 실행되는 유일한 도구이고,
 * 사용자 코드나 파일·비밀을 만지지 않는 오케스트레이션 도구라서 gateway에 둔다.
 */

const ENTRIES: ToolCatalogEntry[] = [
  {
    name: ASK_USER_TOOL,
    description: "사용자에게 객관식 질문을 하고 답을 기다린다 (requires_action)",
    provider: "ask-user",
    runsIn: "gateway",
    enabledByDefault: true,
  },
];

export function createAskUserToolProvider(): ToolProvider {
  return {
    id: "ask-user",
    description: "사용자에게 질문하는 오케스트레이션 도구 (gateway에서 실행)",
    catalog: async () => ENTRIES,
    entryFor: staticEntryLookup(ENTRIES),
    createTools: async () => [createAskUserQuestionTool() as unknown as ToolDefinition],
  };
}
