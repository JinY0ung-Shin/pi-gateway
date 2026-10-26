import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import {
  AUD_BROKER,
  bearerToken,
  isValidUserId,
  MCP_SERVER_ID_PATTERN,
  verifyInternalToken,
  type VisibleServersResponse,
} from "@pi-gateway/shared";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { z } from "zod";
import type { BrokerConfig } from "./config.js";
import { sendWebResponse, toWebRequest } from "./http-bridge.js";
import type { Identity } from "./render.js";
import type { BrokerService } from "./service.js";
import { BROKER_CLIENT_INFO } from "./upstream/connect.js";

interface McpAuthExtra {
  identity: Identity;
  serverId: string;
}

/** 요청 하나를 위한 프록시 서버. 도구만 노출한다. */
function buildProxyServer(service: BrokerService, extra: McpAuthExtra): Server {
  const { identity, serverId } = extra;
  const server = new Server(
    { name: `${BROKER_CLIENT_INFO.name}/${serverId}`, version: BROKER_CLIENT_INFO.version },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler("tools/list", async (_request, ctx) => ({
    tools: await service.listTools(serverId, identity, ctx.mcpReq.signal),
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    // 결과보다 늦게 나가는 진행 알림이 없도록, 결과를 돌려주기 전에 보낸 알림을 기다린다.
    // 결과를 돌려준 뒤에 오는 알림은 버린다 (닫힌 응답 스트림에 쓰면 응답이 끝나지 않을 수 있다).
    const sent: Promise<void>[] = [];
    let finished = false;
    const result = await service.callTool(
      serverId,
      identity,
      { name: request.params.name, arguments: request.params.arguments },
      {
        signal: ctx.mcpReq.signal,
        ...(progressToken !== undefined
          ? {
              onProgress: (progress) => {
                if (finished) return;
                sent.push(
                  ctx.mcpReq
                    .notify({ method: "notifications/progress", params: { ...progress, progressToken } })
                    .catch(() => {}),
                );
              },
            }
          : {}),
      },
    );
    // upstream이 결과와 같은 묶음으로 보낸 진행 알림은 결과보다 한 박자 늦게 처리될 수 있다.
    await new Promise<void>((resolve) => setImmediate(resolve));
    finished = true;
    // 알림 전송이 막혀도 결과를 붙잡지 않는다.
    await Promise.race([Promise.all(sent), new Promise<void>((resolve) => setTimeout(resolve, 2000).unref())]);
    return result;
  });
  return server;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * 데이터 평면 — gateway만 부른다 (control 네트워크).
 * 신원은 오직 검증된 내부 JWT(aud=AUD_BROKER)에서 온다.
 */
export function buildDataPlane(deps: { config: BrokerConfig; service: BrokerService; log: Logger }): FastifyInstance {
  const { config, service } = deps;
  const app = Fastify({
    loggerInstance: deps.log.child({ plane: "data" }) as FastifyBaseLogger,
    bodyLimit: config.limits.maxRequestBodyBytes,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const identities = new WeakMap<FastifyRequest, Identity>();

  // MCP 계층이 직접 파싱하도록 본문을 문자열 그대로 둔다.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const mcp = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as McpAuthExtra | undefined;
      if (!extra) throw new Error("missing broker auth context");
      return buildProxyServer(service, extra);
    },
    {
      legacy: "stateless",
      maxRequestBodySize: config.limits.maxRequestBodyBytes,
      onerror: (error) => deps.log.debug({ err: error.message }, "mcp handler error"),
    },
  );

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/mcp")) return;
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="mcp-broker"')
        .send(errorBody("unauthorized", "missing bearer token"));
    }
    try {
      const claims = await verifyInternalToken(config.jwtSecret, AUD_BROKER, token);
      if (!isValidUserId(claims.sub)) throw new Error("invalid principal");
      const identity: Identity = { sub: claims.sub };
      if (claims.sid) identity.sid = claims.sid;
      if (claims.ctx) identity.ctx = claims.ctx;
      identities.set(req, identity);
    } catch {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="mcp-broker", error="invalid_token"')
        .send(errorBody("unauthorized", "invalid token"));
    }
  });

  app.get("/mcp/servers", async (req): Promise<z.infer<typeof VisibleServersResponse>> => {
    return { servers: service.visibleServers(identities.get(req)!) };
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp/:serverId",
    handler: async (req, reply) => {
      const identity = identities.get(req)!;
      const { serverId } = req.params as { serverId: string };
      if (!MCP_SERVER_ID_PATTERN.test(serverId) || !service.isUsable(serverId)) {
        return reply.code(404).send(errorBody("not_found", `MCP server '${serverId}' is not available`));
      }
      const controller = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      const request = toWebRequest(req, controller.signal, ["authorization"]);
      const response = await mcp.fetch(request, {
        authInfo: {
          token: "",
          clientId: identity.sub,
          scopes: [],
          extra: { identity, serverId } satisfies McpAuthExtra,
        },
      });
      return sendWebResponse(reply, response);
    },
  });

  app.addHook("onClose", async () => {
    await mcp.close();
  });

  return app;
}
