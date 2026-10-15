import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { glob, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  AUD_SANDBOXD,
  AttachStart,
  bearerToken,
  SANDBOXD_ROUTES,
  userKey,
  verifyInternalToken,
} from "@pi-gateway/shared";
import { WebSocketServer } from "ws";

/**
 * 테스트 전용 가짜 sandboxd. 공유 계약(sandbox-api.ts)을 임시 디렉토리 위에서 구현한다.
 * - `/workspace`, `/tmp`는 principal별 임시 디렉토리로 바꿔서 연다.
 * - 명령은 이 머신에서 실행된다 (테스트에서만 쓴다).
 * - 받은 요청을 calls에 기록해서, gateway가 모든 도구 실행을 여기로 보냈는지 확인할 수 있다.
 */

export interface FakeCall {
  route: string;
  user: string;
  /** 토큰의 sid (세션 id) */
  sid?: string;
  body: Record<string, unknown>;
}

export interface FakeSandboxd {
  url: string;
  root: string;
  calls: FakeCall[];
  authFailures: string[];
  /** principal의 가짜 workspace 경로 (호스트) */
  workspaceOf(principal: string): string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export interface FakeSandboxdOptions {
  /** attach 연결은 받지만 started를 보내지 않는다 (멈춘 sandboxd 흉내) */
  stallAttach?: boolean;
}

export async function startFakeSandboxd(secret: Uint8Array, options: FakeSandboxdOptions = {}): Promise<FakeSandboxd> {
  const root = mkdtempSync(join(tmpdir(), "fake-sandboxd-"));
  const calls: FakeCall[] = [];
  const authFailures: string[] = [];

  const dirs = (principal: string) => {
    const key = userKey(principal);
    const ws = join(root, "ws", key);
    const tmp = join(root, "tmp", key);
    mkdirSync(ws, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    return { ws, tmp };
  };

  /** sandbox 경로 → 호스트 경로 */
  const toHost = (principal: string, p: string, cwd = "/workspace"): string => {
    const { ws, tmp } = dirs(principal);
    const abs = p.startsWith("/") ? p : join(cwd, p);
    const norm = resolve(abs);
    if (norm === "/workspace" || norm.startsWith("/workspace/")) return join(ws, relative("/workspace", norm));
    if (norm === "/tmp" || norm.startsWith("/tmp/")) return join(tmp, relative("/tmp", norm));
    throw Object.assign(new Error(`path outside the fake sandbox: ${norm}`), { code: "forbidden" });
  };
  const toSandbox = (principal: string, host: string): string => {
    const { ws, tmp } = dirs(principal);
    if (host.startsWith(ws)) return join("/workspace", relative(ws, host));
    if (host.startsWith(tmp)) return join("/tmp", relative(tmp, host));
    return host;
  };

  /** 성공하면 토큰의 sid(없으면 ""), 실패하면 null */
  const authenticate = async (req: IncomingMessage, user: string | undefined): Promise<string | null> => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      authFailures.push("missing token");
      return null;
    }
    try {
      const claims = await verifyInternalToken(secret, AUD_SANDBOXD, token);
      if (user !== undefined && claims.sub !== user) {
        authFailures.push(`sub ${claims.sub} != user ${user}`);
        return null;
      }
      return claims.sid ?? "";
    } catch (err) {
      authFailures.push(String(err));
      return null;
    }
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  };

  const server: Server = createServer(async (req, res) => {
    const route = (req.url ?? "").split("?")[0]!;
    try {
      if (req.method === "GET" && route === SANDBOXD_ROUTES.list) {
        if ((await authenticate(req, undefined)) === null) return sendJson(res, 401, errorBody("unauthorized", "bad token"));
        return sendJson(res, 200, { sandboxes: [] });
      }
      if (req.method !== "POST") return sendJson(res, 404, errorBody("not_found", "no route"));
      const body = await readBody(req);
      const user = String(body.user ?? "");
      const sid = await authenticate(req, user);
      if (sid === null) return sendJson(res, 401, errorBody("unauthorized", "bad token"));
      calls.push({ route, user, sid, body });

      switch (route) {
        case SANDBOXD_ROUTES.ensure:
          dirs(user);
          return sendJson(res, 200, { key: userKey(user), containerName: `fake-${userKey(user)}`, state: "running", created: false });
        case SANDBOXD_ROUTES.remove:
          if (body.deleteWorkspace) await rm(dirs(user).ws, { recursive: true, force: true });
          return sendJson(res, 200, { ok: true });
        case SANDBOXD_ROUTES.fsRead: {
          const host = toHost(user, String(body.path));
          const st = await stat(host).catch(() => null);
          if (!st) return sendJson(res, 404, errorBody("not_found", "no such file"));
          if (st.isDirectory()) return sendJson(res, 400, errorBody("is_directory", "is a directory"));
          const data = await readFile(host);
          const max = typeof body.maxBytes === "number" ? body.maxBytes : data.length;
          return sendJson(res, 200, { size: data.length, content: data.subarray(0, max).toString("base64"), truncated: data.length > max });
        }
        case SANDBOXD_ROUTES.fsWrite: {
          const host = toHost(user, String(body.path));
          await mkdir(dirname(host), { recursive: true });
          const data = Buffer.from(String(body.content), "base64");
          await writeFile(host, data);
          return sendJson(res, 200, { size: data.length });
        }
        case SANDBOXD_ROUTES.fsStat: {
          const host = toHost(user, String(body.path));
          const st = await lstat(host).catch(() => null);
          if (!st) return sendJson(res, 200, { exists: false });
          const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
          const target = st.isSymbolicLink() ? await stat(host).catch(() => null) : null;
          return sendJson(res, 200, {
            exists: true,
            kind,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ...(target ? { targetIsDir: target.isDirectory() } : {}),
          });
        }
        case SANDBOXD_ROUTES.fsList: {
          const host = toHost(user, String(body.path));
          const st = await stat(host).catch(() => null);
          if (!st) return sendJson(res, 404, errorBody("not_found", "no such directory"));
          if (!st.isDirectory()) return sendJson(res, 400, errorBody("not_directory", "not a directory"));
          const entries = (await readdir(host, { withFileTypes: true }))
            .map((d) => ({ name: d.name, kind: d.isFile() ? "file" : d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "other" }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return sendJson(res, 200, { entries });
        }
        case SANDBOXD_ROUTES.fsMkdir:
          await mkdir(toHost(user, String(body.path)), { recursive: true });
          return sendJson(res, 200, { ok: true });
        case SANDBOXD_ROUTES.fsGlob: {
          const cwd = toHost(user, String(body.cwd ?? "/workspace"));
          const limit = typeof body.limit === "number" ? body.limit : 1000;
          const paths: string[] = [];
          for await (const p of glob(String(body.pattern), { cwd })) {
            paths.push(toSandbox(user, join(cwd, p)));
            if (paths.length >= limit) break;
          }
          paths.sort();
          return sendJson(res, 200, { paths, truncated: paths.length >= limit });
        }
        case SANDBOXD_ROUTES.exec: {
          // 진짜 sandbox에서는 /workspace·/tmp가 그대로 보인다. 여기서는 그 경로 인자를 임시 디렉토리로 바꿔 흉내 낸다.
          const isSandboxPath = (a: string) => a === "/workspace" || a.startsWith("/workspace/") || a === "/tmp" || a.startsWith("/tmp/");
          const argv = (body.argv as string[]).map((a) => (isSandboxPath(a) ? toHost(user, a) : a));
          const cwd = toHost(user, String(body.cwd ?? "/workspace"));
          const env = (body.env ?? {}) as Record<string, string>;
          const { ws, tmp } = dirs(user);
          const child = spawn(argv[0]!, argv.slice(1), {
            cwd,
            // FAKE_SANDBOX_*: 가짜 도구(fake-rg)가 sandbox 경로를 이 머신의 경로로 바꿀 때 쓴다.
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(ws, ".home"), FAKE_SANDBOX_WS: ws, FAKE_SANDBOX_TMP: tmp, ...env },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          const write = (o: unknown) => {
            if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`);
          };
          const started = Date.now();
          let timedOut = false;
          const kill = () => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              /* 이미 끝남 */
            }
          };
          const timer = typeof body.timeoutSec === "number" ? setTimeout(() => ((timedOut = true), kill()), body.timeoutSec * 1000) : undefined;
          res.on("close", () => {
            if (child.exitCode === null) kill();
          });
          write({ type: "started", execId: String(child.pid) });
          if (typeof body.stdin === "string") child.stdin.end(Buffer.from(body.stdin, "base64"));
          else child.stdin.end();
          child.stdout.on("data", (d: Buffer) => write({ type: "stdout", data: d.toString("base64") }));
          child.stderr.on("data", (d: Buffer) => write({ type: "stderr", data: d.toString("base64") }));
          child.on("error", (err) => {
            write({ type: "error", code: "internal", message: err.message });
            res.end();
          });
          child.on("close", (code, signal) => {
            if (timer) clearTimeout(timer);
            write({ type: "exit", exitCode: code, signal, timedOut, truncated: false, durationMs: Date.now() - started });
            res.end();
          });
          return;
        }
        default:
          return sendJson(res, 404, errorBody("not_found", `no route ${route}`));
      }
    } catch (err) {
      const code = (err as { code?: string }).code === "forbidden" ? "forbidden" : "internal";
      return sendJson(res, code === "forbidden" ? 403 : 500, errorBody(code, (err as Error).message));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const sid = (req.url ?? "").split("?")[0] === SANDBOXD_ROUTES.attach ? await authenticate(req, undefined) : null;
    if (sid === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (options.stallAttach) {
        calls.push({ route: SANDBOXD_ROUTES.attach, user: "", sid, body: { stalled: true } });
        return;
      }
      let child: ReturnType<typeof spawn> | undefined;
      ws.on("message", (data, isBinary) => {
        if (!child) {
          if (isBinary) return;
          const start = AttachStart.parse(JSON.parse(data.toString()));
          calls.push({ route: SANDBOXD_ROUTES.attach, user: start.user, sid, body: start as unknown as Record<string, unknown> });
          const cwd = toHost(start.user, start.cwd ?? "/workspace");
          child = spawn(start.argv[0]!, start.argv.slice(1), {
            cwd,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(start.env ?? {}) },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stdout!.on("data", (d: Buffer) => ws.send(d, { binary: true }));
          child.stderr!.on("data", (d: Buffer) => ws.send(JSON.stringify({ type: "stderr", data: d.toString("base64") })));
          child.on("close", (code, signal) => {
            ws.send(JSON.stringify({ type: "exit", exitCode: code, signal }));
            ws.close();
          });
          ws.send(JSON.stringify({ type: "started", procId: String(child.pid) }));
          return;
        }
        if (isBinary) child.stdin!.write(data as Buffer);
      });
      ws.on("close", () => {
        if (child && child.exitCode === null) {
          try {
            process.kill(-child.pid!, "SIGTERM");
          } catch {
            /* 이미 끝남 */
          }
        }
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    root,
    calls,
    authFailures,
    workspaceOf: (principal) => dirs(principal).ws,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => {
          // 이 테스트 프로세스가 만든 임시 디렉토리라 바로 지울 수 있다
          rmSync(root, { recursive: true, force: true });
          r();
        });
      }),
  };
}
