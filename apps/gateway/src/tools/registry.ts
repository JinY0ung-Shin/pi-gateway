import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { McpToolCache } from "../mcp-client/connections.js";
import type { ToolProvider, ToolSessionContext } from "./provider.js";
import { createAskUserToolProvider } from "./providers/ask-user.js";
import { createBrokerMcpToolProvider } from "./providers/mcp-broker.js";
import { createSandboxMcpToolProvider } from "./providers/mcp-sandbox.js";
import { createSandboxToolProvider } from "./providers/sandbox.js";

/**
 * 도구 provider들을 합친다.
 * 결과는 pi createAgentSession의 `tools`(allowlist)와 `customTools`가 된다.
 * 새 provider는 아래 createDefaultToolProviders 한 곳에만 추가한다.
 */

export interface DefaultProviderDeps {
  mcpRegistry: McpRegistry;
  broker: GatewayConfig["broker"];
  mcpCache: McpToolCache;
  /** 세션 생성 시 MCP 서버 하나의 도구 목록 대기 시간 (기본 MCP_LIST_TIMEOUT_MS) */
  mcpListTimeoutMs?: number;
}

/** 등록된 provider 목록 (순서 = 도구 이름이 겹칠 때의 우선순위) */
export function createDefaultToolProviders(deps: DefaultProviderDeps): ToolProvider[] {
  const mcp = {
    registry: deps.mcpRegistry,
    broker: deps.broker,
    cache: deps.mcpCache,
    ...(deps.mcpListTimeoutMs ? { listTimeoutMs: deps.mcpListTimeoutMs } : {}),
  };
  return [
    createSandboxToolProvider(),
    createAskUserToolProvider(),
    createBrokerMcpToolProvider(mcp),
    createSandboxMcpToolProvider(mcp),
  ];
}

export interface SessionToolset {
  customTools: ToolDefinition[];
  /** pi `tools` allowlist — customTools의 이름 전부 */
  toolNames: string[];
}

export class ToolRegistry {
  constructor(
    private readonly providers: readonly ToolProvider[],
    private readonly log: Logger,
  ) {}

  async createSessionTools(ctx: ToolSessionContext): Promise<SessionToolset> {
    const customTools: ToolDefinition[] = [];
    const names = new Set<string>();
    for (const provider of this.providers) {
      let defs: ToolDefinition[];
      try {
        defs = await provider.createTools(ctx);
      } catch (err) {
        // 한 provider가 실패해도 세션은 나머지 도구로 만든다 (예: broker가 잠시 안 됨).
        ctx.log.warn({ err, provider: provider.id }, "tool provider failed; its tools are unavailable in this session");
        continue;
      }
      for (const def of defs) {
        if (names.has(def.name)) {
          ctx.log.warn({ tool: def.name, provider: provider.id }, "duplicate tool name; keeping the first provider's tool");
          continue;
        }
        names.add(def.name);
        customTools.push(def);
      }
    }
    return { customTools, toolNames: [...names] };
  }

  async disposeSession(sessionId: string): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((p) => p.disposeSession?.(sessionId)));
    results.forEach((r, i) => {
      if (r.status === "rejected") this.log.warn({ err: r.reason, provider: this.providers[i]!.id, sessionId }, "tool provider dispose failed");
    });
  }
}
