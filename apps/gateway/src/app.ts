import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { registerAdminRoutes as defaultRegisterAdminRoutes } from "./admin/index.js";
import { createModelRuntime, type GatewayModels } from "./agent/runtime.js";
import { Authenticator } from "./auth/auth.js";
import type { GatewayConfig } from "./config.js";
import type { McpRegistry, PluginResources, PromptService, RegisterAdminRoutes, ToolPolicy } from "./contracts.js";
import { type Db, openDatabase } from "./db.js";
import { shuttingDownError } from "./errors.js";
import { createMcpRegistry } from "./mcp-registry/index.js";
import { McpToolCache } from "./mcp-client/connections.js";
import { createPluginResources } from "./plugins/index.js";
import { createPromptService } from "./prompts/index.js";
import { SandboxClient } from "./sandbox/client.js";
import { buildServer } from "./server.js";
import { SessionHub } from "./sessions/hub.js";
import { TurnLimiter } from "./sessions/limiter.js";
import { SessionStore } from "./sessions/store.js";
import { createToolPolicy } from "./tool-policy/index.js";
import type { ToolProvider } from "./tools/provider.js";
import { createDefaultToolProviders, ToolRegistry } from "./tools/registry.js";

/**
 * gateway 조립: 설정 → DB → platform 서비스 → pi runtime → 도구 → 세션 → HTTP 서버.
 * main.ts와 테스트가 같은 조립을 쓴다. 테스트는 일부 의존성을 바꿔 끼울 수 있다.
 */

export interface GatewayOverrides {
  db?: Db;
  prompts?: PromptService;
  plugins?: PluginResources;
  mcpRegistry?: McpRegistry;
  toolPolicy?: ToolPolicy;
  /** 기본 provider 목록 대신 쓸 provider (테스트·확장용) */
  toolProviders?: (defaults: ToolProvider[]) => ToolProvider[];
  registerAdminRoutes?: RegisterAdminRoutes;
  /** pi settings 덮어쓰기 (테스트에서 retry를 끄는 등) */
  piSettings?: Record<string, unknown>;
  /** 유휴 세션 정리 주기 (0이면 시작하지 않음) */
  reaperIntervalMs?: number;
  /** 세션을 만들 때 MCP 서버 하나의 도구 목록을 기다리는 최대 시간 (테스트용) */
  mcpListTimeoutMs?: number;
}

export interface Gateway {
  app: FastifyInstance;
  hub: SessionHub;
  store: SessionStore;
  tools: ToolRegistry;
  models: GatewayModels;
  limiter: TurnLimiter;
  close(): Promise<void>;
}

export async function createGateway(config: GatewayConfig, logger: Logger, overrides: GatewayOverrides = {}): Promise<Gateway> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = overrides.db ?? openDatabase(join(config.dataDir, "gateway.db"));
  const prompts = overrides.prompts ?? createPromptService(db, config);
  const plugins = overrides.plugins ?? createPluginResources(db, config);
  const mcpRegistry = overrides.mcpRegistry ?? createMcpRegistry(db, config);
  const toolPolicy = overrides.toolPolicy ?? createToolPolicy(db, config);

  const models = await createModelRuntime(config);
  const sandboxClient = new SandboxClient({ baseUrl: config.sandboxd.url, jwtSecret: config.sandboxd.jwtSecret });
  const defaults = createDefaultToolProviders({
    mcpRegistry,
    broker: config.broker,
    mcpCache: new McpToolCache(),
    ...(overrides.mcpListTimeoutMs ? { mcpListTimeoutMs: overrides.mcpListTimeoutMs } : {}),
  });
  const providers = overrides.toolProviders ? overrides.toolProviders(defaults) : defaults;
  const tools = new ToolRegistry(providers, toolPolicy, logger.child({ component: "tools" }));

  const store = new SessionStore(db);
  const hub = new SessionHub({
    store,
    config,
    tools,
    sandboxClient,
    log: logger.child({ component: "sessions" }),
    factory: {
      config,
      models,
      sandboxClient,
      plugins,
      tools,
      log: logger.child({ component: "agent" }),
      ...(overrides.piSettings ? { settingsOverrides: overrides.piSettings } : {}),
    },
  });
  const limiter = new TurnLimiter(
    config.sessions.maxConcurrentTurns,
    config.sessions.maxConcurrentTurnsPerUser,
    config.sessions.maxQueuedTurns,
    config.sessions.queueTimeoutSeconds * 1000,
  );

  const app = await buildServer({
    logger,
    trustProxy: config.trustProxy,
    responses: {
      config,
      store,
      hub,
      limiter,
      auth: new Authenticator(config.auth),
      models,
      prompts,
      plugins,
      log: logger.child({ component: "responses" }),
    },
    admin: {
      config,
      db,
      prompts,
      plugins,
      mcp: mcpRegistry,
      stats: () => {
        const h = hub.stats();
        const l = limiter.stats();
        return { liveSessions: h.liveSessions, activeTurns: l.active, queuedTurns: l.queued };
      },
      sandboxes: () => sandboxClient.list(),
      tools,
      toolPolicy,
    },
    registerAdminRoutes: overrides.registerAdminRoutes ?? defaultRegisterAdminRoutes,
  });

  const interval = overrides.reaperIntervalMs ?? 30_000;
  if (interval > 0) hub.startReaper(interval);

  return {
    app,
    hub,
    store,
    tools,
    models,
    limiter,
    async close() {
      // 1. 새 턴을 받지 않고 실행 중인 턴을 멈춘다 (스트리밍 연결이 끝나야 HTTP 서버가 닫힌다).
      hub.beginShutdown();
      // 2. 동시 실행 대기열에 있던 요청은 바로 503으로 끝낸다.
      limiter.close(shuttingDownError());
      // 3. HTTP 서버를 닫는다. 요청이 끝나 idle이 된 keep-alive 연결도 계속 닫아 줘야 close가 끝난다.
      const idleCloser = setInterval(() => app.server.closeIdleConnections?.(), 100);
      try {
        await app.close();
      } finally {
        clearInterval(idleCloser);
      }
      await hub.shutdown();
      if (!overrides.db) db.close();
    },
  };
}
