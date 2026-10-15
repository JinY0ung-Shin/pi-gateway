import { ADMIN_PRINCIPAL } from "@pi-gateway/shared";
import type { McpServerHandle } from "../../mcp-client/connections.js";
import type { ToolProvider } from "../provider.js";
import { connectionSets, dynamicEntry, type McpProviderDeps, newSet } from "./mcp-shared.js";

/** mcp-broker provider — 비밀키가 필요한 MCP 서버. 연결은 broker로만 가고, 키는 broker가 붙인다. */
export function createBrokerMcpToolProvider(deps: McpProviderDeps): ToolProvider {
  const sets = connectionSets();
  return {
    id: "mcp-broker",
    description: "비밀키가 필요한 MCP 서버. mcp-broker가 키를 붙여 호출한다.",
    async catalog() {
      if (!deps.broker) return [];
      const servers = await deps.registry.brokerServersFor(ADMIN_PRINCIPAL, "catalog");
      return servers.map((s) => dynamicEntry("mcp-broker", "broker", s));
    },
    async createTools(ctx) {
      if (!deps.broker) return [];
      const servers = await deps.registry.brokerServersFor(ctx.principal, ctx.sessionId);
      if (servers.length === 0) return [];
      const set = newSet(deps, ctx);
      await sets.replace(ctx.sessionId, set);
      const handles: McpServerHandle[] = servers.map((s) => ({
        kind: "broker",
        id: s.id,
        timeoutSec: s.timeoutSec,
        ...(s.displayName ? { displayName: s.displayName } : {}),
        ...(s.description ? { description: s.description } : {}),
      }));
      return set.tools(handles, ctx.signal);
    },
    disposeSession: (sessionId) => sets.dispose(sessionId),
  };
}
