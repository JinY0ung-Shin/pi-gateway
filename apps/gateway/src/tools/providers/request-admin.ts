import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolProvider } from "../provider.js";
import { type AdminRequests, createRequestAdminTool } from "../request-admin.js";

/**
 * request-admin provider — request_admin. gateway DB에 요청 한 줄을 남기는 것뿐이라
 * 사용자 코드나 파일·비밀을 만지지 않아 gateway에 둔다.
 */

export function createRequestAdminToolProvider(store: Pick<AdminRequests, "add">): ToolProvider {
  return {
    id: "request-admin",
    createTools: async (ctx) => [createRequestAdminTool(store, ctx) as unknown as ToolDefinition],
  };
}
