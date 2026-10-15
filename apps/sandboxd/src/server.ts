import fastifyWebsocket from "@fastify/websocket";
import {
  ADMIN_PRINCIPAL,
  AttachStart,
  AUD_SANDBOXD,
  bearerToken,
  EnsureSandboxRequest,
  type ExecEvent,
  ExecRequest,
  FsGlobRequest,
  FsListRequest,
  FsMkdirRequest,
  FsReadRequest,
  FsStatRequest,
  FsWriteRequest,
  isValidPrincipal,
  RemoveSandboxRequest,
  SANDBOXD_ROUTES,
  type VerifiedInternalClaims,
  verifyInternalToken,
} from "@pi-gateway/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { RawData, WebSocket } from "ws";
import type { z } from "zod";
import { errorMessage, SandboxError } from "./errors.js";
import type { AttachProcess, SandboxRuntime } from "./runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    claims: VerifiedInternalClaims | null;
  }
}

export interface ServerOptions {
  jwtSecret: Uint8Array;
  runtime: SandboxRuntime;
  logger: Logger;
  /** 첫 AttachStart를 기다리는 시간 */
  attachStartTimeoutMs?: number;
}

const MiB = 1024 * 1024;
/** fs/write의 base64 본문(64MiB 파일 ≈ 86MiB)을 받을 수 있게 */
const BODY_LIMIT = 100 * MiB;
const WS_MAX_PAYLOAD = 16 * MiB;
const WS_HIGH_WATER = 4 * MiB;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
      .join("; ");
    throw new SandboxError("invalid_request", detail);
  }
  return result.data;
}

/** 요청의 user가 토큰 subject와 같은지 확인한다. */
function assertPrincipal(req: FastifyRequest, user: string): void {
  if (!isValidPrincipal(user)) throw new SandboxError("invalid_request", "invalid user");
  if (req.claims?.sub !== user) throw new SandboxError("forbidden", "token subject does not match user");
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  const { runtime } = opts;

  app.decorateRequest("claims", null);

  app.addHook("onRequest", async (req) => {
    if (req.url === SANDBOXD_ROUTES.health) return;
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new SandboxError("unauthorized", "missing bearer token");
    try {
      req.claims = await verifyInternalToken(opts.jwtSecret, AUD_SANDBOXD, token);
    } catch {
      throw new SandboxError("unauthorized", "invalid token");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof SandboxError) {
      if (err.status >= 500) req.log.warn({ code: err.code, err: err.message }, "request failed");
      return reply.code(err.status).send(err.toBody());
    }
    const fastifyErr = err as { code?: string; statusCode?: number; message?: string };
    if (fastifyErr.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: { code: "too_large", message: "request body is too large" } });
    }
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply
        .code(400)
        .send({ error: { code: "invalid_request", message: fastifyErr.message ?? "invalid request" } });
    }
    req.log.error({ err: errorMessage(err) }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "no such route" } }),
  );

  app.get(SANDBOXD_ROUTES.health, async () => ({ ok: true }));

  // ── 컨테이너 수명주기 ──────────────────────────────────────────

  app.post(SANDBOXD_ROUTES.ensure, async (req) => {
    const body = parse(EnsureSandboxRequest, req.body);
    assertPrincipal(req, body.user);
    return runtime.ensure(body.user);
  });

  app.post(SANDBOXD_ROUTES.remove, async (req) => {
    const body = parse(RemoveSandboxRequest, req.body);
    assertPrincipal(req, body.user);
    await runtime.remove(body.user, body.deleteWorkspace);
    return { ok: true };
  });

  app.get(SANDBOXD_ROUTES.list, async (req) => {
    if (req.claims?.sub !== ADMIN_PRINCIPAL) throw new SandboxError("forbidden", "admin token required");
    return { sandboxes: await runtime.list() };
  });

  // ── 명령 실행 (NDJSON) ─────────────────────────────────────────

  app.post(SANDBOXD_ROUTES.exec, async (req, reply) => {
    const params = parse(ExecRequest, req.body);
    assertPrincipal(req, params.user);
    const running = await runtime.prepareExec(params.user, params);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const write = (event: ExecEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      await running.run(write, abort.signal);
    } catch (err) {
      req.log.error({ err: errorMessage(err) }, "exec stream failed");
      write({ type: "error", code: "internal", message: "exec failed" });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  // ── 파일 ──────────────────────────────────────────────────────

  app.post(SANDBOXD_ROUTES.fsRead, async (req) => {
    const body = parse(FsReadRequest, req.body);
    assertPrincipal(req, body.user);
    return runtime.fsRead(body.user, body.path, body.maxBytes);
  });

  app.post(SANDBOXD_ROUTES.fsWrite, async (req) => {
    const body = parse(FsWriteRequest, req.body);
    assertPrincipal(req, body.user);
    const content = Buffer.from(body.content, "base64");
    if (content.toString("base64").replace(/=+$/, "") !== body.content.replace(/=+$/, "")) {
      throw new SandboxError("invalid_request", "content must be base64");
    }
    return runtime.fsWrite(body.user, body.path, content, body.mkdirs);
  });

  app.post(SANDBOXD_ROUTES.fsStat, async (req) => {
    const body = parse(FsStatRequest, req.body);
    assertPrincipal(req, body.user);
    return runtime.fsStat(body.user, body.path);
  });

  app.post(SANDBOXD_ROUTES.fsList, async (req) => {
    const body = parse(FsListRequest, req.body);
    assertPrincipal(req, body.user);
    return runtime.fsList(body.user, body.path);
  });

  app.post(SANDBOXD_ROUTES.fsMkdir, async (req) => {
    const body = parse(FsMkdirRequest, req.body);
    assertPrincipal(req, body.user);
    await runtime.fsMkdir(body.user, body.path, body.recursive);
    return {};
  });

  app.post(SANDBOXD_ROUTES.fsGlob, async (req) => {
    const body = parse(FsGlobRequest, req.body);
    assertPrincipal(req, body.user);
    return runtime.fsGlob(body.user, body);
  });

  // ── 장기 실행 프로세스 (WebSocket) ─────────────────────────────

  app.get(SANDBOXD_ROUTES.attach, { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    handleAttach(socket, req, runtime, opts.attachStartTimeoutMs ?? 10_000);
  });

  return app;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function handleAttach(socket: WebSocket, req: FastifyRequest, runtime: SandboxRuntime, startTimeoutMs: number): void {
  let proc: AttachProcess | null = null;
  let starting = false;
  let closed = false;
  const queued: Buffer[] = [];
  let drainTimer: NodeJS.Timeout | undefined;

  const sendJson = (msg: object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const fail = (code: string, message: string) => {
    sendJson({ type: "error", code, message });
    socket.close(code === "forbidden" || code === "unauthorized" ? 1008 : 1011, code);
  };
  const startTimer = setTimeout(() => {
    if (!proc && !starting) fail("invalid_request", "AttachStart was not received in time");
  }, startTimeoutMs);

  // 클라이언트가 출력을 못 따라오면 컨테이너 쪽 읽기를 멈춘다
  const checkBackpressure = () => {
    if (!proc || drainTimer || socket.bufferedAmount < WS_HIGH_WATER) return;
    proc.pause();
    drainTimer = setInterval(() => {
      if (closed || socket.bufferedAmount < WS_HIGH_WATER / 2) {
        clearInterval(drainTimer);
        drainTimer = undefined;
        proc?.resume();
      }
    }, 20);
  };

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (proc) {
      if (isBinary) proc.write(toBuffer(data));
      return;
    }
    if (starting) {
      if (isBinary) queued.push(toBuffer(data));
      return;
    }
    if (isBinary) return fail("invalid_request", "the first frame must be AttachStart (text)");
    let start;
    try {
      start = AttachStart.parse(JSON.parse(toBuffer(data).toString("utf8")));
    } catch (err) {
      return fail("invalid_request", `invalid AttachStart: ${errorMessage(err).slice(0, 300)}`);
    }
    if (!isValidPrincipal(start.user)) return fail("invalid_request", "invalid user");
    if (req.claims?.sub !== start.user) return fail("forbidden", "token subject does not match user");
    starting = true;
    clearTimeout(startTimer);
    runtime
      .attach(start.user, start, {
        onStdout: (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(chunk, { binary: true });
          checkBackpressure();
        },
        onStderr: (chunk) => sendJson({ type: "stderr", data: chunk.toString("base64") }),
      })
      .then((p) => {
        proc = p;
        if (closed) {
          p.terminate();
          return;
        }
        sendJson({ type: "started", procId: p.procId });
        for (const chunk of queued.splice(0)) p.write(chunk);
        void p.done.then(({ exitCode, signal }) => {
          sendJson({ type: "exit", exitCode, signal });
          if (socket.readyState === socket.OPEN) socket.close(1000, "exited");
        });
      })
      .catch((err: unknown) => {
        const code = err instanceof SandboxError ? err.code : "internal";
        req.log.warn({ err: errorMessage(err) }, "attach failed");
        fail(code, err instanceof SandboxError ? err.message : "attach failed");
      });
  });

  socket.on("close", () => {
    closed = true;
    clearTimeout(startTimer);
    if (drainTimer) clearInterval(drainTimer);
    proc?.terminate();
  });
  socket.on("error", () => {
    proc?.terminate();
  });
}
