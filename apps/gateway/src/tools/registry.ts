import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { McpToolCache } from "../mcp-client/connections.js";
import type { ToolProvider, ToolSessionContext } from "./provider.js";
import { createAskUserToolProvider } from "./providers/ask-user.js";
import { createMcpToolProvider } from "./providers/mcp.js";
import { createSandboxToolProvider } from "./providers/sandbox.js";

/**
 * 도구 provider들을 합친다.
 * 결과는 pi createAgentSession의 `customTools`가 되고, 이름 목록이 `tools`(allowlist)가 된다.
 * 새 provider는 아래 createDefaultToolProviders 한 곳에만 추가한다.
 */

export interface DefaultProviderDeps {
  mcpRegistry: McpRegistry;
  broker: GatewayConfig["broker"];
  mcpCache: McpToolCache;
}

/** 등록된 provider 목록 (순서 = 도구 순서). 도구 이름은 provider끼리 겹치지 않는다 (MCP 도구는 mcp__ 접두사). */
export function createDefaultToolProviders(deps: DefaultProviderDeps): ToolProvider[] {
  return [
    createSandboxToolProvider(),
    createAskUserToolProvider(),
    createMcpToolProvider({ registry: deps.mcpRegistry, broker: deps.broker, cache: deps.mcpCache }),
  ];
}

export class ToolRegistry {
  constructor(
    private readonly providers: readonly ToolProvider[],
    private readonly log: Logger,
  ) {}

  async createSessionTools(ctx: ToolSessionContext): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    for (const provider of this.providers) tools.push(...(await provider.createTools(ctx)));
    return tools;
  }

  async disposeSession(sessionId: string): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((p) => p.disposeSession?.(sessionId)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.log.warn({ err: r.reason, provider: this.providers[i]!.id, sessionId }, "tool provider dispose failed");
    });
  }
}
