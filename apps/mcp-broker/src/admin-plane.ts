import {
  AUD_BROKER_ADMIN,
  bearerToken,
  findLiteralCredentials,
  McpServerConfig,
  PutSecretRequest,
  SecretName,
  TestServerRequest,
  verifyInternalToken,
} from "@pi-gateway/shared";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { z } from "zod";
import type { BrokerConfig } from "./config.js";
import { AdminUpstreamError, type BrokerService } from "./service.js";
import type { BrokerStore } from "./store.js";

/** /mcp/servers와 겹치는 id */
const RESERVED_IDS = new Set(["servers"]);
const MAX_ACTOR_LENGTH = 120;

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function issues(error: z.ZodError): string {
  // 입력값은 넣지 않는다 (비밀값이 섞여 들어올 수 있다).
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 2000);
}

function actorOf(req: FastifyRequest): string {
  const raw = req.headers["x-admin-actor"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "admin";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // 인코딩되지 않은 값이면 그대로 쓴다.
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 제어 문자를 지운다
  const clean = decoded.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_ACTOR_LENGTH);
  return clean || "admin";
}

/**
 * 관리 평면 — gateway의 관리 백엔드만 부른다. 별도 포트, 관리용 audience(AUD_BROKER_ADMIN)의 내부 JWT.
 * 비밀값은 어떤 응답·로그·감사 기록에도 들어가지 않는다.
 */
export function buildAdminPlane(deps: {
  config: BrokerConfig;
  store: BrokerStore;
  service: BrokerService;
  log: Logger;
}): FastifyInstance {
  const { config, store, service } = deps;
  const app = Fastify({
    loggerInstance: deps.log.child({ plane: "admin" }) as FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) deps.log.error({ err: error.message }, "admin request failed");
    // 본문 파싱 오류 메시지에 입력 일부가 들어갈 수 있어서 일반 메시지만 돌려준다.
    return reply
      .code(status)
      .send(errorBody(status === 500 ? "internal" : "invalid_request", status === 500 ? "internal error" : "invalid request"));
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    const token = bearerToken(req.headers.authorization);
    const valid = token !== null && (await verifyInternalToken(config.jwtSecret, AUD_BROKER_ADMIN, token).then(() => true, () => false));
    if (!valid) return reply.code(401).send(errorBody("unauthorized", "invalid admin token"));
  });

  const getServerOr404 = (id: string, reply: FastifyReply) => {
    const server = store.getServer(id);
    if (!server) void reply.code(404).send(errorBody("not_found", `MCP server '${id}' not found`));
    return server;
  };

  app.get("/admin/servers", async () => ({
    servers: store.listServers().map((s) => service.serverView(s)),
  }));

  app.get("/admin/servers/:id", async (req, reply) => {
    const server = getServerOr404((req.params as { id: string }).id, reply);
    if (!server) return reply;
    return service.serverView(server);
  });

  app.put("/admin/servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply.code(400).send(errorBody("invalid_request", "body must be a JSON object"));
    }
    const input = body as Record<string, unknown>;
    if (input.id !== undefined && input.id !== id) {
      return reply.code(400).send(errorBody("invalid_request", "body id must match the path"));
    }
    if (RESERVED_IDS.has(id)) return reply.code(400).send(errorBody("invalid_request", `'${id}' is a reserved id`));
    const parsed = McpServerConfig.safeParse({ ...input, id });
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_request", issues(parsed.error)));
    const cfg = parsed.data;
    if (cfg.runIn !== "broker") {
      return reply.code(400).send(errorBody("invalid_request", "only runIn=broker servers are stored in the broker"));
    }
    const problems = findLiteralCredentials(cfg);
    if (problems.length > 0) return reply.code(400).send(errorBody("invalid_request", problems.join("; ")));

    const { server, created, clearedSecrets } = store.upsertServer(cfg);
    service.forgetServer(id);
    const actor = actorOf(req);
    store.addAudit({
      actor,
      action: created ? "server.create" : "server.update",
      serverId: id,
      detail: `transport=${cfg.transport.type} enabled=${cfg.enabled} scope=${cfg.scope} revision=${server.revision}`,
    });
    if (clearedSecrets.length > 0) {
      // 비밀값이 가는 곳이 바뀌었다. 새 행선지로 기존 비밀값을 보내지 않도록 다시 입력받는다.
      store.addAudit({
        actor,
        action: "secret.invalidate",
        serverId: id,
        detail: `transport target changed; cleared secrets: ${clearedSecrets.join(", ")}`,
      });
      deps.log.warn({ serverId: id, secrets: clearedSecrets }, "transport target changed; stored secrets cleared");
    }
    return reply.code(created ? 201 : 200).send(service.serverView(server));
  });

  app.delete("/admin/servers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteServer(id)) return reply.code(404).send(errorBody("not_found", `MCP server '${id}' not found`));
    service.forgetServer(id);
    store.addAudit({ actor: actorOf(req), action: "server.delete", serverId: id });
    return reply.code(204).send();
  });

  app.put("/admin/servers/:id/secrets/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!SecretName.safeParse(name).success) {
      return reply.code(400).send(errorBody("invalid_request", "secret name must match [A-Za-z0-9_.-]{1,64}"));
    }
    const parsed = PutSecretRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_request", issues(parsed.error)));
    const meta = store.putSecret(id, name, parsed.data.value);
    if (!meta) return reply.code(404).send(errorBody("not_found", `MCP server '${id}' not found`));
    if (parsed.data.value.length < 8) {
      deps.log.warn({ serverId: id, secret: name }, "secret is shorter than 8 characters; redaction may be unreliable");
    }
    service.forgetServer(id);
    store.addAudit({
      actor: actorOf(req),
      action: "secret.put",
      serverId: id,
      detail: `name=${name} version=${meta.version} fingerprint=${meta.fingerprint}`,
    });
    return reply.code(204).send();
  });

  app.delete("/admin/servers/:id/secrets/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!store.getServer(id)) return reply.code(404).send(errorBody("not_found", `MCP server '${id}' not found`));
    if (!store.deleteSecret(id, name)) return reply.code(404).send(errorBody("not_found", `secret '${name}' not found`));
    service.forgetServer(id);
    store.addAudit({ actor: actorOf(req), action: "secret.delete", serverId: id, detail: `name=${name}` });
    return reply.code(204).send();
  });

  app.post("/admin/servers/:id/test", async (req, reply) => {
    const server = getServerOr404((req.params as { id: string }).id, reply);
    if (!server) return reply;
    const parsed = TestServerRequest.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_request", issues(parsed.error)));
    const result = await service.testServer(server, parsed.data.user);
    store.addAudit({
      actor: actorOf(req),
      action: "server.test",
      serverId: server.config.id,
      detail: result.ok ? `ok tools=${result.tools?.length ?? 0}` : "failed",
    });
    return result;
  });

  app.get("/admin/servers/:id/tools", async (req, reply) => {
    const server = getServerOr404((req.params as { id: string }).id, reply);
    if (!server) return reply;
    const user = (req.query as { user?: string }).user;
    try {
      return { tools: await service.adminTools(server, user || undefined) };
    } catch (error) {
      const message = error instanceof AdminUpstreamError ? error.message : "upstream error";
      return reply.code(502).send(errorBody("upstream_error", message));
    }
  });

  app.get("/admin/audit", async (req) => {
    const raw = Number((req.query as { limit?: string }).limit ?? 100);
    const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 1000) : 100;
    return { events: store.listAudit(limit) };
  });

  return app;
}
