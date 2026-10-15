import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  type AttachStart,
  type ExecEvent,
  type ExecRequest,
  type FsGlobRequest,
  type FsGlobResponse,
  type FsListResponse,
  type FsReadResponse,
  type FsStatResponse,
  SANDBOX_WORKSPACE,
  type SandboxInfo,
} from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import type { SandboxdConfig } from "./config.js";
import {
  decodeExit,
  Demuxer,
  execCollect,
  pump,
  HELPER_ENV,
  SBX_FS,
  SBX_RUN,
  type StartedExec,
  signalProcessGroup,
  startExec,
  TIMEOUT_BIN,
  waitExitCode,
} from "./docker-exec.js";
import { dockerStatus, errorMessage, SandboxError, toErrorCode } from "./errors.js";
import type { Lease, SandboxManager } from "./manager.js";
import { containerName } from "./spec.js";

export type ExecParams = z.output<typeof ExecRequest>;
export type GlobParams = z.output<typeof FsGlobRequest>;
export type AttachParams = z.output<typeof AttachStart>;

const KILL_GRACE_MS = 5000;

/** 계약: 상대 경로는 /workspace 기준 */
function sandboxCwd(cwd: string): string {
  return posix.resolve(SANDBOX_WORKSPACE, cwd);
}
const MiB = 1024 * 1024;

export interface RunningExec {
  execId: string;
  /** 출력을 이벤트로 흘려보내고, exit(또는 error) 이벤트를 마지막으로 보낸 뒤 끝난다. */
  run(onEvent: (event: ExecEvent) => void, signal: AbortSignal): Promise<void>;
}

export interface AttachIO {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

export interface AttachProcess {
  procId: string;
  write(chunk: Buffer): void;
  /** 클라이언트 쪽 출력이 밀릴 때 읽기를 멈추고 다시 시작한다 */
  pause(): void;
  resume(): void;
  /** process group에 SIGTERM, 5초 뒤에도 살아 있으면 SIGKILL */
  terminate(): void;
  done: Promise<{ exitCode: number | null; signal: string | null }>;
}

/** HTTP 라우트가 의존하는 sandbox 동작. 테스트에서는 가짜 구현으로 바꿔 끼운다. */
export interface SandboxRuntime {
  ensure(principal: string): Promise<SandboxInfo>;
  list(): Promise<SandboxInfo[]>;
  /** 컨테이너를 준비하고 exec를 시작한다. 여기서 던진 오류는 스트림을 열기 전에 JSON 오류로 나간다. */
  prepareExec(principal: string, params: ExecParams): Promise<RunningExec>;
  fsRead(principal: string, path: string, maxBytes: number): Promise<FsReadResponse>;
  fsWrite(principal: string, path: string, content: Buffer, mkdirs: boolean): Promise<{ size: number }>;
  fsStat(principal: string, path: string): Promise<FsStatResponse>;
  fsList(principal: string, path: string): Promise<FsListResponse>;
  fsMkdir(principal: string, path: string, recursive: boolean): Promise<void>;
  fsGlob(principal: string, params: GlobParams): Promise<FsGlobResponse>;
  attach(principal: string, params: AttachParams, io: AttachIO): Promise<AttachProcess>;
}

/** 컨테이너가 사라졌거나 멈춰서 exec가 실패한 경우 (한 번 다시 만들고 재시도한다) */
function isContainerGone(err: unknown): boolean {
  const status = dockerStatus(err);
  return status === 404 || status === 409;
}

export class DockerSandboxRuntime implements SandboxRuntime {
  constructor(
    private readonly manager: SandboxManager,
    private readonly config: SandboxdConfig,
    private readonly log: Logger,
  ) {}

  async ensure(principal: string): Promise<SandboxInfo> {
    const lease = await this.manager.acquire(principal);
    lease.release();
    return {
      key: lease.key,
      containerName: containerName(this.config, lease.key),
      state: "running",
      created: lease.created,
      lastActiveAt: new Date().toISOString(),
    };
  }

  list(): Promise<SandboxInfo[]> {
    return this.manager.list();
  }

  /** lease를 얻고 exec를 시작한다. 컨테이너가 없어졌으면 한 번 다시 만든다. */
  private async startWithLease(
    principal: string,
    build: () => { argv: string[]; cwd: string; env: Record<string, string>; stdin: boolean },
  ): Promise<{ lease: Lease; started: StartedExec }> {
    for (let attempt = 0; ; attempt++) {
      const lease = await this.manager.acquire(principal);
      try {
        const started = await startExec(lease.container, build());
        return { lease, started };
      } catch (err) {
        lease.invalidate();
        lease.release();
        if (attempt === 0 && isContainerGone(err)) continue;
        throw new SandboxError("sandbox_unavailable", `exec failed: ${errorMessage(err)}`);
      }
    }
  }

  async prepareExec(principal: string, params: ExecParams): Promise<RunningExec> {
    const execId = randomUUID();
    // sbx-run의 자체 시간 제한은 sandboxd가 죽었을 때를 위한 안전장치라서 조금 늦게 잡는다
    const fallbackTimeout = params.timeoutSec ? params.timeoutSec + 5 : 0;
    const { lease, started } = await this.startWithLease(principal, () => ({
      argv: [SBX_RUN, "exec", execId, String(fallbackTimeout), sandboxCwd(params.cwd), "--", ...params.argv],
      cwd: "/",
      env: params.env,
      stdin: params.stdin !== undefined,
    }));
    const { exec, socket } = started;
    const container = lease.container;
    const log = this.log;

    return {
      execId,
      async run(onEvent, signal) {
        const startedAt = Date.now();
        let total = 0;
        let truncated = false;
        let killing = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        let timeoutTimer: NodeJS.Timeout | undefined;

        const kill = () => {
          if (killing) return;
          killing = true;
          void signalProcessGroup(container, execId, "TERM");
          killTimer = setTimeout(() => void signalProcessGroup(container, execId, "KILL"), KILL_GRACE_MS);
          killTimer.unref();
        };
        const onAbort = () => kill();

        try {
          onEvent({ type: "started", execId });
          const demux = new Demuxer((stream, chunk) => {
            if (truncated) return;
            const room = params.maxOutputBytes - total;
            if (chunk.length > room) {
              if (room > 0) onEvent({ type: stream, data: chunk.subarray(0, room).toString("base64") });
              total = params.maxOutputBytes;
              truncated = true;
              return;
            }
            total += chunk.length;
            onEvent({ type: stream, data: chunk.toString("base64") });
          });
          const ended = pump(socket, demux);
          if (params.stdin !== undefined) {
            socket.write(Buffer.from(params.stdin, "base64"));
            socket.end();
          }
          if (params.timeoutSec) {
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              kill();
            }, params.timeoutSec * 1000);
          }
          if (signal.aborted) kill();
          else signal.addEventListener("abort", onAbort, { once: true });

          try {
            await ended;
          } catch (err) {
            onEvent({ type: "error", code: "sandbox_unavailable", message: `exec stream failed: ${errorMessage(err)}` });
            return;
          } finally {
            socket.destroy();
          }
          const code = await waitExitCode(exec).catch(() => null);
          const { exitCode, signal: sig } = decodeExit(code, killing);
          onEvent({
            type: "exit",
            exitCode,
            signal: sig,
            timedOut,
            truncated,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          log.error({ err: errorMessage(err), execId }, "exec failed");
          onEvent({ type: "error", code: "internal", message: "exec failed" });
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          // 끝난 뒤의 KILL 예약은 필요 없다
          if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener("abort", onAbort);
          lease.release();
        }
      },
    };
  }

  /** sbx-fs 한 번 실행. 첫 줄의 JSON 헤더를 해석하고 나머지 바이트를 돌려준다. */
  private async fsHelper(
    principal: string,
    args: string[],
    opts: { stdin?: Buffer; maxBytes: number },
  ): Promise<{ header: Record<string, unknown>; rest: Buffer }> {
    const argv = [TIMEOUT_BIN, "-k", "5", String(this.config.fsTimeoutSeconds), SBX_FS, ...args];
    for (let attempt = 0; ; attempt++) {
      const lease = await this.manager.acquire(principal);
      let result;
      try {
        const collectOpts: Parameters<typeof execCollect>[2] = { maxBytes: opts.maxBytes, cwd: SANDBOX_WORKSPACE, env: HELPER_ENV };
        if (opts.stdin !== undefined) collectOpts.stdin = opts.stdin;
        result = await execCollect(lease.container, argv, collectOpts);
      } catch (err) {
        lease.invalidate();
        if (attempt === 0 && isContainerGone(err)) continue;
        throw new SandboxError("sandbox_unavailable", `exec failed: ${errorMessage(err)}`);
      } finally {
        lease.release();
      }
      if (result.exitCode === 124 || result.exitCode === 137) {
        throw new SandboxError("timeout", `file operation timed out after ${this.config.fsTimeoutSeconds}s`);
      }
      if (result.overflow) throw new SandboxError("too_large", "file operation output is too large");
      const nl = result.stdout.indexOf(0x0a);
      if (nl < 0) {
        const stderr = result.stderr.toString("utf8").trim().slice(0, 500);
        throw new SandboxError("internal", `sbx-fs gave no result (exit ${result.exitCode}): ${stderr}`);
      }
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(result.stdout.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new SandboxError("internal", "sbx-fs gave an invalid result");
      }
      if (header.ok !== true) {
        throw new SandboxError(toErrorCode(header.code), typeof header.message === "string" ? header.message : "failed");
      }
      return { header, rest: result.stdout.subarray(nl + 1) };
    }
  }

  async fsRead(principal: string, path: string, maxBytes: number): Promise<FsReadResponse> {
    const { header, rest } = await this.fsHelper(principal, ["read", path, String(maxBytes)], {
      maxBytes: maxBytes + 64 * 1024,
    });
    return {
      size: Number(header.size ?? rest.length),
      content: rest.toString("base64"),
      truncated: header.truncated === true,
    };
  }

  async fsWrite(principal: string, path: string, content: Buffer, mkdirs: boolean): Promise<{ size: number }> {
    const { header } = await this.fsHelper(principal, ["write", path, mkdirs ? "1" : "0"], {
      stdin: content,
      maxBytes: 64 * 1024,
    });
    return { size: Number(header.size ?? content.length) };
  }

  async fsStat(principal: string, path: string): Promise<FsStatResponse> {
    const { header } = await this.fsHelper(principal, ["stat", path], { maxBytes: 64 * 1024 });
    if (header.exists !== true) return { exists: false };
    const res: FsStatResponse = { exists: true };
    if (typeof header.kind === "string") res.kind = header.kind as NonNullable<FsStatResponse["kind"]>;
    if (typeof header.size === "number") res.size = header.size;
    if (typeof header.mtimeMs === "number") res.mtimeMs = header.mtimeMs;
    if (typeof header.targetIsDir === "boolean") res.targetIsDir = header.targetIsDir;
    return res;
  }

  async fsList(principal: string, path: string): Promise<FsListResponse> {
    const { header } = await this.fsHelper(principal, ["list", path], { maxBytes: 64 * MiB });
    return { entries: (header.entries ?? []) as FsListResponse["entries"] };
  }

  async fsMkdir(principal: string, path: string, recursive: boolean): Promise<void> {
    await this.fsHelper(principal, ["mkdir", path, recursive ? "1" : "0"], { maxBytes: 64 * 1024 });
  }

  async fsGlob(principal: string, params: GlobParams): Promise<FsGlobResponse> {
    const { header } = await this.fsHelper(
      principal,
      ["glob", params.cwd, String(params.limit), params.pattern, ...params.ignore],
      { maxBytes: 64 * MiB },
    );
    return { paths: (header.paths ?? []) as string[], truncated: header.truncated === true };
  }

  async attach(principal: string, params: AttachParams, io: AttachIO): Promise<AttachProcess> {
    const procId = randomUUID();
    const { lease, started } = await this.startWithLease(principal, () => ({
      argv: [SBX_RUN, "exec", procId, "0", sandboxCwd(params.cwd), "--", ...params.argv],
      cwd: "/",
      env: params.env,
      stdin: true,
    }));
    const { exec, socket } = started;
    const container = lease.container;
    let killing = false;
    let killTimer: NodeJS.Timeout | undefined;
    const demux = new Demuxer((stream, chunk) => {
      if (stream === "stdout") io.onStdout(Buffer.from(chunk));
      else io.onStderr(Buffer.from(chunk));
    });
    const done = (async () => {
      try {
        await pump(socket, demux).catch((err: unknown) => {
          this.log.warn({ procId, err: errorMessage(err) }, "attach stream failed");
        });
        socket.destroy();
        const code = await waitExitCode(exec).catch(() => null);
        return decodeExit(code, killing);
      } finally {
        if (killTimer) clearTimeout(killTimer);
        lease.release();
      }
    })();
    return {
      procId,
      write: (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      },
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      terminate: () => {
        if (killing) return;
        killing = true;
        void signalProcessGroup(container, procId, "TERM");
        killTimer = setTimeout(() => void signalProcessGroup(container, procId, "KILL"), KILL_GRACE_MS);
        killTimer.unref();
      },
      done,
    };
  }
}
