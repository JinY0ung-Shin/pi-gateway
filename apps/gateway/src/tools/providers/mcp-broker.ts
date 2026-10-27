import type { McpServerHandle } from "../../mcp-client/connections.js";
import type { ToolProvider } from "../provider.js";
import { connectionSets, type McpProviderDeps, newSet } from "./mcp-shared.js";

/** mcp-broker provider — 비밀키가 필요한 MCP 서버. 연결은 broker로만 가고, 키는 broker가 붙인다. */
export function createBrokerMcpToolProvider(deps: McpProviderDeps): ToolProvider {
  const sets = connectionSets();
  return {
    id: "mcp-broker",
    async createTools(ctx) {
      const servers = await deps.registry.brokerServersFor(ctx.principal, ctx.sessionId);
      if (servers.length === 0) return [];
      const set = newSet(deps, ctx);
      await sets.replace(ctx.sessionId, set);
      const handles: McpServerHandle[] = servers.map((s) => ({
        kind: "broker",
        id: s.id,
        timeoutSec: s.timeoutSec,
        ...(s.displayName ? { displayName: s.displayName } : {}),
      }));
      return set.tools(handles, ctx.signal);
    },
    disposeSession: (sessionId) => sets.dispose(sessionId),
  };
}
