import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionTool } from "../ask-user.js";
import type { ToolProvider } from "../provider.js";
import { type AdminRequests, createRequestAdminTool } from "../request-admin.js";

/**
 * gateway provider — AskUserQuestion, request_admin. gateway 안에서 실행되는 도구는 이 둘뿐이다.
 * 질문을 클라이언트에 넘기거나 gateway DB에 요청 한 줄을 남길 뿐, 사용자 코드나 파일·비밀을 만지지 않는
 * 오케스트레이션 도구라서 gateway에 둔다.
 */

export function createGatewayToolProvider(adminRequests: Pick<AdminRequests, "add">): ToolProvider {
  return {
    id: "gateway",
    createTools: async (ctx) => [
      createAskUserQuestionTool() as unknown as ToolDefinition,
      createRequestAdminTool(adminRequests, ctx) as unknown as ToolDefinition,
    ],
  };
}
