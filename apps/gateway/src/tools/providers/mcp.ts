import type { GatewayConfig } from "../../config.js";
import type { McpRegistry } from "../../contracts.js";
import { McpConnectionSet, type McpServerHandle, type McpToolCache } from "../../mcp-client/connections.js";
import type { ToolProvider } from "../provider.js";

/**
 * MCP provider. 서버는 두 가지다.
 * - broker 서버: 비밀키가 필요한 서버. 연결은 broker로만 가고, broker가 키를 붙인다.
 * - sandbox 서버: 비밀키가 없는 stdio 서버. 사용자 sandbox 안에서 실행된다.
 * broker가 안 되거나 서버 하나가 실패해도 나머지 도구로 세션을 연다 (brokerServersFor, McpConnectionSet.tools).
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
      const handles: McpServerHandle[] = [
        ...(await deps.registry.brokerServersFor(ctx.principal, ctx.sessionId)).map(
          (s): McpServerHandle => ({ kind: "broker", id: s.id, timeoutSec: s.timeoutSec, ...(s.displayName ? { displayName: s.displayName } : {}) }),
        ),
        ...deps.registry.sandboxServers().map(
          (config): McpServerHandle => ({
            kind: "sandbox",
            id: config.id,
            timeoutSec: config.timeoutSec,
            config,
            ...(config.displayName ? { displayName: config.displayName } : {}),
          }),
        ),
      ];
      await dispose(ctx.sessionId);
      if (handles.length === 0) return [];
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
      return set.tools(handles, ctx.signal);
    },
    disposeSession: dispose,
  };
}
