import type { GatewayConfig } from "../../config.js";
import type { McpRegistry } from "../../contracts.js";
import { McpConnectionSet, type McpServerHandle, type McpToolCache } from "../../mcp-client/connections.js";
import { createMcpProxyTools, type ProxiedServer } from "../../mcp-client/proxy.js";
import type { ToolProvider } from "../provider.js";

/**
 * MCP provider. 서버는 두 가지다.
 * - broker 서버: 비밀키가 필요한 서버. 연결은 broker로만 가고, broker가 키를 붙인다.
 * - sandbox 서버: 비밀키가 없는 stdio 서버. 사용자 sandbox 안에서 실행된다. 명령을 실행하는 것이라 read_only 세션에는 붙이지 않는다.
 * 도구는 하나씩 선언하지 않고 mcp_search·mcp_call로 쓴다 (mcp-client/proxy.ts).
 * broker가 안 되거나 서버 하나가 실패해도 나머지 도구로 세션을 연다 (brokerServersFor, McpConnectionSet.tools).
 * 목록을 못 받은 서버는 mcp_search·mcp_call이 나중에 다시 물어본다 (McpConnectionSet.retryFailed).
 */

export interface McpProviderDeps {
  registry: McpRegistry;
  broker: GatewayConfig["broker"];
  cache: McpToolCache;
}

export function createMcpToolProvider(deps: McpProviderDeps): ToolProvider {
  const sets = new Map<string, McpConnectionSet>();
  const dispose = async (sessionId: string) => {
    const set = sets.get(sessionId);
    sets.delete(sessionId);
    await set?.close();
  };
  return {
    id: "mcp",
    async createTools(ctx) {
      const servers: { handle: McpServerHandle; info: ProxiedServer }[] = [
        ...(await deps.registry.brokerServersFor(ctx.principal, ctx.sessionId)).map((s) => ({
          handle: { kind: "broker" as const, id: s.id, timeoutSec: s.timeoutSec, ...(s.displayName ? { displayName: s.displayName } : {}) },
          info: s,
        })),
        ...(ctx.readOnly ? [] : deps.registry.sandboxServers()).map((config) => ({
          handle: {
            kind: "sandbox" as const,
            id: config.id,
            timeoutSec: config.timeoutSec,
            config,
            ...(config.displayName ? { displayName: config.displayName } : {}),
          },
          info: config,
        })),
      ];
      await dispose(ctx.sessionId);
      if (servers.length === 0) return [];
      const set = new McpConnectionSet({
        broker: deps.broker,
        sandbox: ctx.sandbox,
        principal: ctx.principal,
        sessionId: ctx.sessionId,
        requestContext: ctx.requestContext,
        cache: deps.cache,
        log: ctx.log,
      });
      sets.set(ctx.sessionId, set);
      const tools = await set.tools(servers.map((s) => s.handle), ctx.signal);
      return createMcpProxyTools(tools, servers.map((s) => s.info), set);
    },
    disposeSession: dispose,
  };
}
