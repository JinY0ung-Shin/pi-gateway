import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { bearerToken, errorBody, isValidUserId, sendWebResponse, toWebRequest } from "@pi-gateway/shared";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import type { MemoryConfig } from "./config.js";
import { registerWikiRoutes } from "./rest.js";
import { callTool, TOOL_LIST } from "./tools.js";
import { WikiStore } from "./wiki.js";

/**
 * memory 서비스 — 주인별 wiki를 내놓는다. 포트를 공개하지 않고, 키를 가진 쪽만 부른다.
 * - `/mcp/<owner>`: MCP(streamable HTTP). mcp-broker가 URL에 `{{user}}`를 넣어 그 사용자의 wiki를 모델에게 준다.
 * - `/wiki/<owner>/…`: 프로그램용 JSON API (rest.ts). 같은 compose 스택에 있으면서 누가 누구의 메모리를 볼지 스스로 정하는
 *   BFF가 허락한 주인을 직접 넣어 부른다 (docs/OPERATIONS.md "장기 메모리").
 * 누구의 wiki인지는 URL에서만 오고 도구 인자나 본문에는 없다.
 */

/** 요청 본문 최대 크기. 노트 한도(512KiB)가 JSON으로 감싸져 들어온다. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: "memory" } });
}

/** 요청 하나를 위한 MCP 서버. 그 요청의 주인 wiki만 본다. */
function buildServer(store: WikiStore, owner: string, log: Logger): Server {
  const server = new Server({ name: "pi-gateway-memory", version: "0.1.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler("tools/list", async () => ({ tools: TOOL_LIST }));
  server.setRequestHandler("tools/call", (request) => callTool(store, owner, request.params.name, request.params.arguments, log));
  return server;
}

export function createMemoryService(config: MemoryConfig, options: { log: Logger }): FastifyInstance {
  const { log } = options;
  const store = new WikiStore(config.dataDir);
  const apiKey = digest(config.apiKey);
  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    bodyLimit: MAX_BODY_BYTES,
    // 사용자 id는 128자까지다 (라우터 기본값은 100자). %-인코딩한 표기도 받도록 넉넉히 두고, 형식은 isValidUserId가 본다.
    routerOptions: { maxParamLength: 128 * 3 },
    logController: new LogController({ disableRequestLogging: true }),
  });

  // MCP 계층이 직접 파싱하도록 본문을 문자열 그대로 둔다.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const mcp = createMcpHandler(
    (ctx) => {
      const owner = (ctx.authInfo?.extra as { owner?: string } | undefined)?.owner;
      if (!owner) throw new Error("missing memory owner");
      return buildServer(store, owner, log);
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (error) => log.debug({ err: error.message }, "mcp handler error"),
    },
  );

  app.get("/healthz", async () => ({ ok: true }));

  // healthz가 아닌 모든 요청이 키를 낸다. 맞춰진 라우트로 고른다: URL 글자로 고르면 라우터가 풀어 주는 다른 표기(%6dcp, absolute-form)가 검사를 건너뛴다.
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.url === "/healthz") return;
    const token = bearerToken(req.headers.authorization);
    if (!token || !timingSafeEqual(digest(token), apiKey)) {
      return reply.code(401).header("www-authenticate", 'Bearer realm="memory"').send(errorBody("unauthorized", "missing or invalid key"));
    }
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/:owner",
    handler: async (req, reply) => {
      const { owner } = req.params as { owner: string };
      if (!isValidUserId(owner)) return reply.code(400).send(errorBody("invalid_owner", "the owner in the URL is not a valid user id"));
      const controller = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      const response = await mcp.fetch(toWebRequest(req, controller.signal, "http://memory.internal"), {
        authInfo: { token: "", clientId: owner, scopes: [], extra: { owner } },
      });
      return sendWebResponse(reply, response);
    },
  });

  registerWikiRoutes(app, store, log);

  app.addHook("onClose", async () => {
    await mcp.close();
  });

  return app;
}
