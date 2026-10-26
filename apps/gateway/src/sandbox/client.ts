import {
  ADMIN_PRINCIPAL,
  ApiErrorBody,
  AttachServerMessage,
  AUD_SANDBOXD,
  ExecEvent,
  type ExecRequest,
  type FsGlobResponse,
  type FsListResponse,
  type FsStatResponse,
  ListSandboxesResponse,
  SANDBOXD_ROUTES,
  type SandboxInfo,
  signInternalToken,
} from "@pi-gateway/shared";
import WebSocket from "ws";

/**
 * sandboxd 클라이언트 (계약: packages/shared/src/sandbox-api.ts).
 * 요청마다 새 내부 JWT(sub=principal, sid=세션)를 붙인다.
 */

export class SandboxError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.status = status;
  }
}

export interface SandboxClientOptions {
  baseUrl: string;
  jwtSecret: Uint8Array;
  /** exec·attach를 제외한 요청의 제한 시간 */
  requestTimeoutMs?: number;
}

export interface ExecHandlers {
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export type ExecInput = Omit<ExecRequest, "user">;

export interface AttachedProcess {
  readonly procId: string;
  write(data: Buffer | string): void;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  onExit(listener: (info: { exitCode: number | null; signal: string | null; error?: string }) => void): void;
  close(): void;
}

export class SandboxClient {
  readonly baseUrl: string;
  readonly jwtSecret: Uint8Array;
  readonly requestTimeoutMs: number;

  constructor(options: SandboxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.jwtSecret = options.jwtSecret;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  for(principal: string, sessionId?: string): SandboxHandle {
    return new SandboxHandle(this, principal, sessionId);
  }

  /** 관리용 목록 (토큰 sub=`_admin`) */
  async list(): Promise<SandboxInfo[]> {
    const token = await signInternalToken(this.jwtSecret, AUD_SANDBOXD, { sub: ADMIN_PRINCIPAL });
    const res = await fetch(this.baseUrl + SANDBOXD_ROUTES.list, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) throw await toSandboxError(res);
    return ListSandboxesResponse.parse(await res.json()).sandboxes;
  }
}

async function toSandboxError(res: Response): Promise<SandboxError> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = ApiErrorBody.parse(JSON.parse(text));
    return new SandboxError(parsed.error.code, parsed.error.message, res.status);
  } catch {
    return new SandboxError(res.status >= 500 ? "sandbox_unavailable" : "invalid_request", text || res.statusText, res.status);
  }
}

function abortError(): Error {
  return new Error("aborted");
}

export class SandboxHandle {
  constructor(
    private readonly client: SandboxClient,
    readonly principal: string,
    readonly sessionId: string | undefined,
  ) {}

  private async authHeader(): Promise<string> {
    const token = await signInternalToken(this.client.jwtSecret, AUD_SANDBOXD, {
      sub: this.principal,
      ...(this.sessionId ? { sid: this.sessionId } : {}),
    });
    return `Bearer ${token}`;
  }

  private async post(route: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs ?? this.client.requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(this.client.baseUrl + route, {
        method: "POST",
        headers: { authorization: await this.authHeader(), "content-type": "application/json" },
        body: JSON.stringify({ ...body, user: this.principal }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (timeout.aborted) throw new SandboxError("timeout", `sandbox request timed out (${route})`);
      throw new SandboxError("sandbox_unavailable", `sandboxd is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw await toSandboxError(res);
    return res;
  }

  private async postJson<T>(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.post(route, body, signal);
    return (await res.json()) as T;
  }

  /** 명령을 실행하고 NDJSON 스트림을 끝까지 읽는다. signal이 abort되면 Error("aborted")를 던진다. */
  async exec(input: ExecInput, handlers: ExecHandlers = {}): Promise<ExecResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    handlers.signal?.addEventListener("abort", onAbort, { once: true });
    if (handlers.signal?.aborted) controller.abort();
    // 실행 자체의 제한은 sandboxd가 timeoutSec로 건다. 여기서는 응답 헤더까지만 기다린다.
    try {
      const res = await this.post(
        SANDBOXD_ROUTES.exec,
        input as Record<string, unknown>,
        controller.signal,
        input.timeoutSec ? (input.timeoutSec + 60) * 1000 : 24 * 3600 * 1000,
      );
      if (!res.body) throw new SandboxError("internal", "exec response has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      let result: ExecResult | undefined;
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        const event = ExecEvent.parse(JSON.parse(line));
        switch (event.type) {
          case "stdout":
            handlers.onStdout?.(Buffer.from(event.data, "base64"));
            break;
          case "stderr":
            handlers.onStderr?.(Buffer.from(event.data, "base64"));
            break;
          case "exit":
            result = {
              exitCode: event.exitCode,
              signal: event.signal,
              timedOut: event.timedOut,
              truncated: event.truncated,
              durationMs: event.durationMs,
            };
            break;
          case "error":
            throw new SandboxError(event.code, event.message);
          default:
            break;
        }
      };
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        handleLine(buffer);
      } catch (err) {
        if (handlers.signal?.aborted) throw abortError();
        throw err;
      }
      if (handlers.signal?.aborted) throw abortError();
      if (!result) throw new SandboxError("internal", "exec stream ended without an exit event");
      return result;
    } finally {
      handlers.signal?.removeEventListener("abort", onAbort);
    }
  }

  async readFile(path: string, maxBytes?: number, signal?: AbortSignal): Promise<{ size: number; content: Buffer; truncated: boolean }> {
    const body = await this.postJson<{ size: number; content: string; truncated: boolean }>(
      SANDBOXD_ROUTES.fsRead,
      { path, ...(maxBytes !== undefined ? { maxBytes } : {}) },
      signal,
    );
    return { size: body.size, content: Buffer.from(body.content, "base64"), truncated: body.truncated };
  }

  async writeFile(path: string, content: Buffer | string, signal?: AbortSignal): Promise<{ size: number }> {
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    return this.postJson(SANDBOXD_ROUTES.fsWrite, { path, content: data.toString("base64"), mkdirs: true }, signal);
  }

  async stat(path: string, signal?: AbortSignal): Promise<FsStatResponse> {
    return this.postJson(SANDBOXD_ROUTES.fsStat, { path }, signal);
  }

  async list(path: string, signal?: AbortSignal): Promise<FsListResponse["entries"]> {
    const body = await this.postJson<FsListResponse>(SANDBOXD_ROUTES.fsList, { path }, signal);
    return body.entries;
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.post(SANDBOXD_ROUTES.fsMkdir, { path, recursive: true }, signal);
  }

  async glob(
    input: { cwd: string; pattern: string; ignore?: string[]; limit?: number },
    signal?: AbortSignal,
  ): Promise<FsGlobResponse> {
    return this.postJson(SANDBOXD_ROUTES.fsGlob, input, signal);
  }

  /**
   * 장기 실행 stdio 프로세스를 띄운다 (WS /v1/attach). started 메시지를 받으면 resolve한다.
   * startTimeoutMs 안에 started가 오지 않으면 소켓을 끊고 timeout 오류를 낸다 (멈춘 sandboxd가 턴을 붙잡지 않게).
   */
  async attach(
    input: { argv: string[]; cwd?: string; env?: Record<string, string> },
    signal?: AbortSignal,
    startTimeoutMs = 15_000,
  ): Promise<AttachedProcess> {
    const url = new URL(this.client.baseUrl + SANDBOXD_ROUTES.attach);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { headers: { authorization: await this.authHeader() } });
    const stdoutListeners: ((chunk: Buffer) => void)[] = [];
    const stderrListeners: ((chunk: Buffer) => void)[] = [];
    const exitListeners: ((info: { exitCode: number | null; signal: string | null; error?: string }) => void)[] = [];
    let exited = false;
    const emitExit = (info: { exitCode: number | null; signal: string | null; error?: string }) => {
      if (exited) return;
      exited = true;
      for (const l of exitListeners) l(info);
    };

    return new Promise<AttachedProcess>((resolve, reject) => {
      let started = false;
      let startTimer: NodeJS.Timeout | undefined;
      const fail = (err: Error) => {
        if (startTimer) clearTimeout(startTimer);
        signal?.removeEventListener("abort", onAbort);
        if (!started) reject(err);
        else emitExit({ exitCode: null, signal: null, error: err.message });
      };
      const onAbort = () => {
        ws.terminate();
        fail(abortError());
      };
      if (signal?.aborted) {
        ws.terminate();
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      startTimer = setTimeout(() => {
        ws.terminate();
        fail(new SandboxError("timeout", `sandbox process did not start within ${Math.round(startTimeoutMs / 1000)}s`));
      }, startTimeoutMs);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "start", argv: input.argv, cwd: input.cwd, env: input.env ?? {}, user: this.principal }));
      });
      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          for (const l of stdoutListeners) l(buf);
          return;
        }
        let msg: AttachServerMessage;
        try {
          msg = AttachServerMessage.parse(JSON.parse(buf.toString("utf8")));
        } catch {
          return;
        }
        if (msg.type === "started") {
          started = true;
          if (startTimer) clearTimeout(startTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve({
            procId: msg.procId,
            write: (chunk) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk, { binary: true });
            },
            onStdout: (l) => stdoutListeners.push(l),
            onStderr: (l) => stderrListeners.push(l),
            onExit: (l) => {
              exitListeners.push(l);
            },
            close: () => {
              if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
            },
          });
        } else if (msg.type === "stderr") {
          const chunk = Buffer.from(msg.data, "base64");
          for (const l of stderrListeners) l(chunk);
        } else if (msg.type === "exit") {
          emitExit({ exitCode: msg.exitCode, signal: msg.signal });
        } else if (msg.type === "error") {
          fail(new SandboxError(msg.code, msg.message));
        }
      });
      ws.on("unexpected-response", (_req, res) => {
        fail(new SandboxError(res.statusCode && res.statusCode >= 500 ? "sandbox_unavailable" : "unauthorized", `attach rejected: HTTP ${res.statusCode}`, res.statusCode ?? 0));
      });
      ws.on("error", (err) => fail(new SandboxError("sandbox_unavailable", `attach failed: ${err.message}`)));
      ws.on("close", () => {
        if (!started) reject(new SandboxError("sandbox_unavailable", "attach closed before start"));
        emitExit({ exitCode: null, signal: null });
      });
    });
  }
}
