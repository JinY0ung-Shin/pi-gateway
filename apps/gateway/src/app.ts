import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import { createModelRuntime, type GatewayModels } from "./agent/runtime.js";
import { Authenticator } from "./auth/auth.js";
import type { GatewayConfig } from "./config.js";
import type { McpRegistry, PluginResources, PromptService } from "./contracts.js";
import { type Db, openDatabase } from "./db.js";
import { sendWorkspaceFile } from "./api/files.js";
import { responseId } from "./api/request.js";
import { cancelResponse, createResponse, previewSession, type ResponsesDeps } from "./api/responses.js";
import { ApiError, shuttingDownError } from "./errors.js";
import { McpToolCache } from "./mcp-client/connections.js";
import { McpRegistryService } from "./mcp-registry/service.js";
import { PluginService } from "./plugins/service.js";
import { PromptManager } from "./prompts/service.js";
import { SandboxClient } from "./sandbox/client.js";
import { buildServer } from "./server.js";
import { SessionHub } from "./sessions/hub.js";
import { TurnLimiter } from "./sessions/limiter.js";
import { SessionStore } from "./sessions/store.js";
import { createDefaultToolProviders, ToolRegistry } from "./tools/registry.js";
import { AdminRequests } from "./tools/request-admin.js";
import { ToolSettings } from "./tools/settings.js";
import { ToolStats } from "./tools/stats.js";

/**
 * gateway 조립: 설정 → DB → 프롬프트·plugin·MCP 서비스 → pi runtime → 도구 → 세션 → HTTP 서버.
 * main.ts와 테스트가 같은 조립을 쓴다. 테스트는 일부 의존성을 바꿔 끼울 수 있다.
 */

export interface GatewayOverrides {
  db?: Db;
  /** 세션이 쓰는 프롬프트·plugin·MCP (관리 화면은 DB의 실제 서비스를 그대로 쓴다) */
  prompts?: PromptService;
  plugins?: PluginResources;
  mcpRegistry?: McpRegistry;
  /** pi settings 덮어쓰기 (테스트에서 retry를 끄는 등) */
  piSettings?: Record<string, unknown>;
  /** 유휴 세션 정리 주기 (0이면 시작하지 않음) */
  reaperIntervalMs?: number;
}

export interface Gateway {
  app: FastifyInstance;
  hub: SessionHub;
  store: SessionStore;
  models: GatewayModels;
  limiter: TurnLimiter;
  close(): Promise<void>;
}

export async function createGateway(config: GatewayConfig, logger: Logger, overrides: GatewayOverrides = {}): Promise<Gateway> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = overrides.db ?? openDatabase(join(config.dataDir, "gateway.db"));
  const promptManager = new PromptManager(db, config);
  const mcpService = new McpRegistryService(db, config, logger.child({ component: "mcp-registry" }));
  const pluginService = new PluginService(db, config, { registry: mcpService, log: logger.child({ component: "plugins" }) });
  const prompts = overrides.prompts ?? promptManager;
  const plugins = overrides.plugins ?? pluginService;
  const mcpRegistry = overrides.mcpRegistry ?? mcpService;

  const models = await createModelRuntime(db);
  const sandboxClient = new SandboxClient({ baseUrl: config.sandboxd.url, jwtSecret: config.sandboxd.jwtSecret });
  const adminRequests = new AdminRequests(db);
  const providers = createDefaultToolProviders({
    mcpRegistry,
    broker: config.broker,
    mcpCache: new McpToolCache(),
    adminRequests,
  });
  const tools = new ToolRegistry(providers, logger.child({ component: "tools" }));
  const toolSettings = new ToolSettings(db);
  const toolStats = new ToolStats(db);

  const store = new SessionStore(db);
  const hub = new SessionHub({
    store,
    log: logger.child({ component: "sessions" }),
    factory: {
      config,
      models,
      sandboxClient,
      plugins,
      tools,
      toolSettings,
      toolStats,
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

  const responses: ResponsesDeps = {
    config,
    store,
    hub,
    limiter,
    auth: new Authenticator(config.auth),
    models,
    prompts,
    plugins,
    mcpRegistry,
    sandbox: sandboxClient,
    toolStats,
    log: logger.child({ component: "responses" }),
  };
  const app = await buildServer({
    logger,
    trustProxy: config.trustProxy,
    responses,
    admin: {
      config,
      db,
      log: logger.child({ component: "admin" }),
      prompts: promptManager,
      plugins: pluginService,
      mcp: mcpService,
      stats: () => {
        const l = limiter.stats();
        return { liveSessions: hub.stats().liveSessions, activeTurns: l.active, queuedTurns: l.queued };
      },
      activeTurns: () =>
        hub.activeTurns().map((t) => ({ user: t.user, responseId: responseId(t.sessionId, t.turn), startedAt: new Date(t.startedAt).toISOString() })),
      sandboxes: () => sandboxClient.list(),
      llm: models,
      toolSettings,
      toolStats,
      adminRequests,
      sessions: store,
      chat: {
        respond: (req, reply) => sendApiErrors(reply, () => createResponse(responses, req, reply, { kind: "service" })),
        cancel: (req, reply) => sendApiErrors(reply, async () => cancelResponse(responses, req, { kind: "service" })),
        preview: (req, reply) => sendApiErrors(reply, () => previewSession(responses, req.body)),
        file: (req, reply) => sendApiErrors(reply, () => sendWorkspaceFile(responses, req, reply, { kind: "service" })),
        forwardHeaders: () => mcpRegistry.forwardHeaders(),
      },
    },
  });

  const interval = overrides.reaperIntervalMs ?? 30_000;
  if (interval > 0) hub.startReaper(interval);

  return {
    app,
    hub,
    store,
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

/** 관리 API의 오류 처리기는 ApiError를 모른다. 관리 화면 채팅은 /v1/responses와 같은 오류 본문으로 보낸다. */
async function sendApiErrors(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return reply.code(err.status).headers(err.headers).send(err.body);
    throw err;
  }
}
