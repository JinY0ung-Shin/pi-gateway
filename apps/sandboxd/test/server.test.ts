import type { ExecEvent, SandboxInfo } from "@pi-gateway/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import WebSocketClient from "ws";
import type WebSocket from "ws";
import { SandboxError } from "../src/errors.js";
import type {
  AttachIO,
  AttachParams,
  AttachProcess,
  ExecParams,
  GlobParams,
  RunningExec,
  SandboxRuntime,
} from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import { brokerTokenFor, SECRET, silentLogger, tokenFor } from "./helpers.js";
import { jwtSecretBytes } from "@pi-gateway/shared";

/** Docker 없이 라우트·인증·검증만 시험하는 가짜 runtime */
class FakeRuntime implements SandboxRuntime {
  calls: string[] = [];
  execEvents: ExecEvent[] = [];
  prepareError: SandboxError | null = null;
  fsError: SandboxError | null = null;
  lastExec: ExecParams | null = null;
  lastAbort: AbortSignal | null = null;

  async ensure(principal: string): Promise<SandboxInfo> {
    this.calls.push(`ensure:${principal}`);
    return { key: "u-000000000000000000000000", containerName: "c", state: "running", created: true };
  }
  async remove(principal: string, deleteWorkspace: boolean): Promise<void> {
    this.calls.push(`remove:${principal}:${deleteWorkspace}`);
  }
  async list(): Promise<SandboxInfo[]> {
    return [{ key: "u-000000000000000000000000", containerName: "c", state: "running" }];
  }
  async prepareExec(principal: string, params: ExecParams): Promise<RunningExec> {
    if (this.prepareError) throw this.prepareError;
    this.calls.push(`exec:${principal}`);
    this.lastExec = params;
    return {
      execId: "e1",
      run: async (onEvent, signal) => {
        this.lastAbort = signal;
        for (const ev of this.execEvents) onEvent(ev);
      },
    };
  }
  private fs<T>(value: T): T {
    if (this.fsError) throw this.fsError;
    return value;
  }
  async fsRead() {
    return this.fs({ size: 3, content: Buffer.from("abc").toString("base64"), truncated: false });
  }
  async fsWrite(_p: string, _path: string, content: Buffer) {
    return this.fs({ size: content.length });
  }
  async fsStat() {
    return this.fs({ exists: false });
  }
  async fsList() {
    return this.fs({ entries: [{ name: "a", kind: "file" as const }] });
  }
  async fsMkdir() {
    this.fs(undefined);
  }
  async fsGlob(_p: string, params: GlobParams) {
    return this.fs({ paths: [`${params.cwd}/x`], truncated: false });
  }
  async attach(_principal: string, params: AttachParams, io: AttachIO): Promise<AttachProcess> {
    let resolveDone!: (v: { exitCode: number | null; signal: string | null }) => void;
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((r) => (resolveDone = r));
    this.calls.push(`attach:${params.argv.join(" ")}`);
    return {
      procId: "p1",
      // cat처럼 받은 그대로 돌려준다. "EXIT"를 받으면 끝난다.
      write: (chunk) => {
        if (chunk.toString() === "EXIT") resolveDone({ exitCode: 0, signal: null });
        else io.onStdout(chunk);
      },
      pause: () => undefined,
      resume: () => undefined,
      terminate: () => {
        this.calls.push("terminate");
        resolveDone({ exitCode: null, signal: "SIGTERM" });
      },
      done,
    };
  }
}

let runtime: FakeRuntime;
let app: FastifyInstance;

beforeEach(async () => {
  runtime = new FakeRuntime();
  app = await buildServer({ jwtSecret: SECRET, runtime, logger: silentLogger, attachStartTimeoutMs: 300 });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const auth = async (sub: string) => ({ authorization: `Bearer ${await tokenFor(sub)}` });

describe("인증", () => {
  it("healthz는 토큰 없이 열린다", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("토큰이 없거나, 비밀키가 다르거나, audience가 다르면 401", async () => {
    const body = { user: "alice" };
    const none = await app.inject({ method: "POST", url: "/v1/sandboxes/ensure", payload: body });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: "unauthorized", message: "missing bearer token" } });
    const wrongSecret = await tokenFor("alice", { secret: jwtSecretBytes("z".repeat(40)) });
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/sandboxes/ensure",
      payload: body,
      headers: { authorization: `Bearer ${wrongSecret}` },
    });
    expect(r2.statusCode).toBe(401);
    const r3 = await app.inject({
      method: "POST",
      url: "/v1/sandboxes/ensure",
      payload: body,
      headers: { authorization: `Bearer ${await brokerTokenFor("alice")}` },
    });
    expect(r3.statusCode).toBe(401);
    expect(runtime.calls).toEqual([]);
  });

  it("본문의 user가 토큰 subject와 다르면 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/exec",
      payload: { user: "bob", argv: ["true"] },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
    expect(runtime.calls).toEqual([]);
  });

  it("principal 형식이 이상하면 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sandboxes/ensure",
      payload: { user: "../etc" },
      headers: await auth("../etc"),
    });
    expect(res.statusCode).toBe(400);
  });

  it("목록은 _admin 토큰만 볼 수 있다", async () => {
    const user = await app.inject({ method: "GET", url: "/v1/sandboxes", headers: await auth("alice") });
    expect(user.statusCode).toBe(403);
    const admin = await app.inject({ method: "GET", url: "/v1/sandboxes", headers: await auth("_admin") });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().sandboxes).toHaveLength(1);
  });
});

describe("검증과 오류 형식", () => {
  it("스키마에 맞지 않으면 400 invalid_request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/exec",
      payload: { user: "alice", argv: [] },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("runtime 오류는 상태 코드와 {error:{code,message}}로 나간다", async () => {
    runtime.fsError = new SandboxError("not_found", "nope");
    const res = await app.inject({
      method: "POST",
      url: "/v1/fs/read",
      payload: { user: "alice", path: "x" },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "nope" } });
  });

  it("base64가 아닌 write 본문은 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/fs/write",
      payload: { user: "alice", path: "x", content: "***not base64***" },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(400);
  });

  it("기본값이 채워져 runtime에 전달된다", async () => {
    runtime.execEvents = [{ type: "exit", exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 }];
    await app.inject({ method: "POST", url: "/v1/exec", payload: { user: "alice", argv: ["true"] }, headers: await auth("alice") });
    expect(runtime.lastExec).toMatchObject({ cwd: "/workspace", env: {}, maxOutputBytes: 8 * 1024 * 1024 });
    const glob = await app.inject({
      method: "POST",
      url: "/v1/fs/glob",
      payload: { user: "alice", pattern: "*.ts" },
      headers: await auth("alice"),
    });
    expect(glob.json()).toEqual({ paths: ["/workspace/x"], truncated: false });
  });

  it("없는 경로는 404 not_found", async () => {
    const res = await app.inject({ method: "GET", url: "/nope", headers: await auth("alice") });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("exec NDJSON", () => {
  it("이벤트를 한 줄씩 흘려보낸다", async () => {
    runtime.execEvents = [
      { type: "started", execId: "e1" },
      { type: "stdout", data: Buffer.from("hi\n").toString("base64") },
      { type: "exit", exitCode: 0, signal: null, timedOut: false, truncated: false, durationMs: 5 },
    ];
    const res = await app.inject({
      method: "POST",
      url: "/v1/exec",
      payload: { user: "alice", argv: ["echo", "hi"] },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l) as ExecEvent);
    expect(lines.map((l) => l.type)).toEqual(["started", "stdout", "exit"]);
  });

  it("시작 전 오류는 스트림이 아니라 JSON 오류로 나간다", async () => {
    runtime.prepareError = new SandboxError("sandbox_unavailable", "docker down");
    const res = await app.inject({
      method: "POST",
      url: "/v1/exec",
      payload: { user: "alice", argv: ["true"] },
      headers: await auth("alice"),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "sandbox_unavailable", message: "docker down" } });
  });
});

describe("attach (WebSocket)", () => {
  const nextMessage = (ws: WebSocket) =>
    new Promise<{ data: Buffer; isBinary: boolean }>((resolve) =>
      ws.once("message", (data, isBinary) => resolve({ data: data as Buffer, isBinary })),
    );

  it("AttachStart 후 binary stdin/stdout을 주고받고, 끝나면 exit을 보낸다", async () => {
    const ws = await app.injectWS("/v1/attach", { headers: await auth("alice") });
    const started = nextMessage(ws);
    ws.send(JSON.stringify({ type: "start", user: "alice", argv: ["cat"] }));
    expect(JSON.parse((await started).data.toString())).toEqual({ type: "started", procId: "p1" });
    const echoed = nextMessage(ws);
    ws.send(Buffer.from('{"jsonrpc":"2.0"}\n'), { binary: true });
    const echo = await echoed;
    expect(echo.isBinary).toBe(true);
    expect(echo.data.toString()).toBe('{"jsonrpc":"2.0"}\n');
    const exit = nextMessage(ws);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send(Buffer.from("EXIT"), { binary: true });
    expect(JSON.parse((await exit).data.toString())).toEqual({ type: "exit", exitCode: 0, signal: null });
    expect(await closed).toBe(1000);
  });

  it("다른 사용자로 시작하려 하면 forbidden으로 닫는다", async () => {
    const ws = await app.injectWS("/v1/attach", { headers: await auth("alice") });
    const msg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "start", user: "bob", argv: ["cat"] }));
    expect(JSON.parse((await msg).data.toString())).toMatchObject({ type: "error", code: "forbidden" });
    expect(runtime.calls).toEqual([]);
    ws.terminate();
  });

  it("토큰이 없으면 업그레이드를 거부한다", async () => {
    await expect(app.injectWS("/v1/attach", {})).rejects.toThrow(/401/);
  });

  it("AttachStart가 늦으면 끊는다", async () => {
    const ws = await app.injectWS("/v1/attach", { headers: await auth("alice") });
    const msg = await nextMessage(ws);
    expect(JSON.parse(msg.data.toString())).toMatchObject({ type: "error", code: "invalid_request" });
    ws.terminate();
  });

  it("클라이언트가 닫으면 프로세스를 종료한다 (실제 TCP 연결)", async () => {
    // injectWS의 가짜 스트림은 close handshake가 끝나지 않으므로 실제 소켓으로 시험한다
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocketClient(`ws://127.0.0.1:${port}/v1/attach`, { headers: await auth("alice") });
    await new Promise((r) => ws.once("open", r));
    const started = nextMessage(ws);
    ws.send(JSON.stringify({ type: "start", user: "alice", argv: ["cat"] }));
    await started;
    ws.close();
    for (let i = 0; i < 100 && !runtime.calls.includes("terminate"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(runtime.calls).toContain("terminate");
  });
});
