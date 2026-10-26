import type { McpServerHandle } from "../../mcp-client/connections.js";
import type { ToolProvider } from "../provider.js";
import { connectionSets, type McpProviderDeps, newSet } from "./mcp-shared.js";

/** mcp-sandbox provider — 비밀키가 없는 stdio MCP 서버. 사용자 sandbox 컨테이너 안에서 실행된다. */
export function createSandboxMcpToolProvider(deps: McpProviderDeps): ToolProvider {
  const sets = connectionSets();
  return {
    id: "mcp-sandbox",
    async createTools(ctx) {
      const servers = deps.registry.sandboxServers();
      if (servers.length === 0) return [];
      const set = newSet(deps, ctx);
      await sets.replace(ctx.sessionId, set);
      const handles: McpServerHandle[] = servers.map((config) => ({
        kind: "sandbox",
        id: config.id,
        timeoutSec: config.timeoutSec,
        config,
        ...(config.displayName ? { displayName: config.displayName } : {}),
        ...(config.description ? { description: config.description } : {}),
      }));
      return set.tools(handles, ctx.signal);
    },
    disposeSession: (sessionId) => sets.dispose(sessionId),
  };
}
