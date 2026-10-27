import type { GatewayConfig } from "../../config.js";
import type { McpRegistry } from "../../contracts.js";
import { McpConnectionSet, type McpServerHandle, type McpToolCache } from "../../mcp-client/connections.js";
import { createMcpProxyTools, type ProxiedServer } from "../../mcp-client/proxy.js";
import type { ToolProvider } from "../provider.js";

/**
 * MCP provider. 서버는 두 가지다.
 * - broker 서버: 비밀키가 필요한 서버. 연결은 broker로만 가고, broker가 키를 붙인다.
 * - sandbox 서버: 비밀키가 없는 stdio 서버. 사용자 sandbox 안에서 실행된다.
 * plugin이 등록한 서버의 도구는 skill이 이름으로 부르므로 모델에게 바로 선언한다.
 * 관리 화면에서 등록한 서버의 도구는 mcp_search·mcp_call로 쓴다 (mcp-client/proxy.ts).
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
      const servers: { handle: McpServerHandle; plugin: boolean; info: ProxiedServer }[] = [
        ...(await deps.registry.brokerServersFor(ctx.principal, ctx.sessionId)).map((s) => ({
          handle: { kind: "broker" as const, id: s.id, timeoutSec: s.timeoutSec, ...(s.displayName ? { displayName: s.displayName } : {}) },
          plugin: s.plugin === true,
          info: s,
        })),
        ...deps.registry.sandboxServers().map((config) => ({
          handle: {
            kind: "sandbox" as const,
            id: config.id,
            timeoutSec: config.timeoutSec,
            config,
            ...(config.displayName ? { displayName: config.displayName } : {}),
          },
          plugin: config.source.kind === "plugin",
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
      const proxied = servers.filter((s) => !s.plugin);
      const [direct, behindProxy] = await Promise.all([
        set.tools(
          servers.filter((s) => s.plugin).map((s) => s.handle),
          ctx.signal,
        ),
        set.tools(
          proxied.map((s) => s.handle),
          ctx.signal,
        ),
      ]);
      return [...direct, ...createMcpProxyTools(behindProxy, proxied.map((s) => s.info))];
    },
    disposeSession: dispose,
  };
}
