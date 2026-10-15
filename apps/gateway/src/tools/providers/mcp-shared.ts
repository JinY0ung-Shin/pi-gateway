import type { GatewayConfig } from "../../config.js";
import type { McpRegistry, ToolCatalogEntry } from "../../contracts.js";
import { McpConnectionSet, type McpToolCache } from "../../mcp-client/connections.js";
import type { ToolSessionContext } from "../provider.js";

/**
 * MCP provider 두 가지.
 * - mcp-broker: 비밀키가 필요한 서버. 연결은 broker로만 가고, broker가 키를 붙인다.
 * - mcp-sandbox: 비밀키가 없는 stdio 서버. 사용자 sandbox 안에서 실행된다.
 * 도구는 사용자·서버에 따라 달라서 catalog에는 `mcp__<id>__*` 대표 항목으로 보여준다.
 */

export interface McpProviderDeps {
  registry: McpRegistry;
  broker: GatewayConfig["broker"];
  cache: McpToolCache;
  listTimeoutMs?: number;
}

export function dynamicEntry(provider: string, runsIn: ToolCatalogEntry["runsIn"], s: { id: string; displayName?: string; description?: string }): ToolCatalogEntry {
  return {
    name: `mcp__${s.id}__*`,
    description: s.description ?? s.displayName ?? `MCP server ${s.id}`,
    provider,
    runsIn,
    enabledByDefault: true,
    dynamic: true,
  };
}

export function connectionSets() {
  const sets = new Map<string, McpConnectionSet>();
  return {
    async replace(sessionId: string, set: McpConnectionSet): Promise<void> {
      const previous = sets.get(sessionId);
      sets.set(sessionId, set);
      await previous?.close();
    },
    async dispose(sessionId: string): Promise<void> {
      const set = sets.get(sessionId);
      sets.delete(sessionId);
      await set?.close();
    },
  };
}

export function newSet(deps: McpProviderDeps, ctx: ToolSessionContext): McpConnectionSet {
  return new McpConnectionSet({
    broker: deps.broker,
    sandbox: ctx.sandbox,
    principal: ctx.principal,
    sessionId: ctx.sessionId,
    requestContext: ctx.requestContext,
    cache: deps.cache,
    log: ctx.log,
    ...(deps.listTimeoutMs ? { listTimeoutMs: deps.listTimeoutMs } : {}),
  });
}
