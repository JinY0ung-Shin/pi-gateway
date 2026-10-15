import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type Docker from "dockerode";
import { SANDBOX_GID, SANDBOX_UID } from "@pi-gateway/shared";

export const SBX_RUN = "/usr/local/bin/sbx-run";
export const SBX_FS = "/usr/local/bin/sbx-fs";
export const TIMEOUT_BIN = "/usr/bin/timeout";
/**
 * sandboxd가 직접 부르는 도우미(sbx-fs, sbx-run kill)의 환경. 컨테이너 기본 PATH 대신 시스템 경로만 쓴다
 * (workspace에 심어 둔 같은 이름의 실행 파일이 끼어들지 못하게).
 */
export const HELPER_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/nonexistent",
  XDG_CONFIG_HOME: "/nonexistent",
  LANG: "C.UTF-8",
};

export type StreamName = "stdout" | "stderr";

/**
 * Docker 다중화 스트림(Tty=false) 해석기.
 * 프레임 = 8바이트 헤더 [type, 0, 0, 0, size(uint32 BE)] + payload. type 1=stdout, 2=stderr.
 */
export class Demuxer {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly onFrame: (stream: StreamName, chunk: Buffer) => void) {}

  push(data: Buffer): void {
    this.pending.push(data);
    this.pendingBytes += data.length;
    for (;;) {
      if (this.pendingBytes < 8) return;
      const head = this.peek(8);
      const size = head.readUInt32BE(4);
      if (this.pendingBytes < 8 + size) return;
      const frame = this.take(8 + size);
      const type = frame[0];
      const payload = frame.subarray(8);
      if (payload.length === 0) continue;
      if (type === 1) this.onFrame("stdout", payload);
      else if (type === 2) this.onFrame("stderr", payload);
    }
  }

  private peek(n: number): Buffer {
    const first = this.pending[0]!;
    if (first.length >= n) return first.subarray(0, n);
    return Buffer.concat(this.pending, n);
  }

  private take(n: number): Buffer {
    const first = this.pending[0]!;
    if (first.length === n) {
      this.pending.shift();
      this.pendingBytes -= n;
      return first;
    }
    if (first.length > n) {
      this.pending[0] = first.subarray(n);
      this.pendingBytes -= n;
      return first.subarray(0, n);
    }
    const all = Buffer.concat(this.pending, this.pendingBytes);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
    return out;
  }
}

export interface StartedExec {
  exec: Docker.Exec;
  socket: Duplex;
}

export interface StartExecOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: boolean;
}

export async function startExec(container: Docker.Container, opts: StartExecOptions): Promise<StartedExec> {
  const exec = await container.exec({
    Cmd: opts.argv,
    AttachStdin: opts.stdin,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    WorkingDir: opts.cwd,
    Env: Object.entries(opts.env).map(([k, v]) => `${k}=${v}`),
    User: `${SANDBOX_UID}:${SANDBOX_GID}`,
    Privileged: false,
  });
  const socket = (await exec.start({ hijack: true, stdin: opts.stdin, Detach: false, Tty: false })) as unknown as Duplex;
  return { exec, socket };
}

/** 스트림이 끝날 때까지 demuxer로 흘려보낸다. */
export function pump(socket: Duplex, demux: Demuxer): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve();
    };
    socket.on("data", (chunk: Buffer) => demux.push(chunk));
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (err) => finish(err));
  });
}

/** 스트림이 끝난 뒤 종료 코드를 가져온다. Docker가 상태를 늦게 갱신하는 경우가 있어 잠깐 기다린다. */
export async function waitExitCode(exec: Docker.Exec, timeoutMs = 3000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  for (;;) {
    const info = await exec.inspect();
    if (!info.Running) return typeof info.ExitCode === "number" ? info.ExitCode : null;
    if (Date.now() > deadline) return null;
    await sleep(delay);
    delay = Math.min(delay * 2, 100);
  }
}

export interface CollectedExec {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  /** maxBytes를 넘어서 뒤를 버렸는지 */
  overflow: boolean;
}

/** 짧은 도우미 명령을 실행하고 출력을 모은다. */
export async function execCollect(
  container: Docker.Container,
  argv: string[],
  opts: { stdin?: Buffer; cwd?: string; env?: Record<string, string>; maxBytes: number },
): Promise<CollectedExec> {
  const { exec, socket } = await startExec(container, {
    argv,
    cwd: opts.cwd ?? "/",
    env: opts.env ?? {},
    stdin: opts.stdin !== undefined,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const demux = new Demuxer((stream, chunk) => {
    if (overflow) return;
    if (size + chunk.length > opts.maxBytes) {
      overflow = true;
      return;
    }
    size += chunk.length;
    (stream === "stdout" ? out : err).push(Buffer.from(chunk));
  });
  const ended = pump(socket, demux);
  if (opts.stdin !== undefined) {
    socket.write(opts.stdin);
    socket.end();
  }
  try {
    await ended;
  } finally {
    socket.destroy();
  }
  const exitCode = await waitExitCode(exec);
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode, overflow };
}

/** sbx-run kill: process group 전체에 신호를 보낸다. 실패해도 조용히 넘어간다 (이미 끝났을 수 있다). */
export async function signalProcessGroup(container: Docker.Container, execId: string, sig: "TERM" | "KILL"): Promise<void> {
  try {
    await execCollect(container, [SBX_RUN, "kill", execId, sig], { maxBytes: 4096, env: HELPER_ENV });
  } catch {
    // 컨테이너가 이미 사라졌거나 프로세스가 끝났다
  }
}

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/**
 * sbx-run의 종료 코드 해석. 우리가 신호를 보낸 경우에만 128+N을 신호로 본다
 * (그 외에는 명령이 직접 그 코드로 끝났을 수도 있으므로 숫자 그대로 둔다).
 */
export function decodeExit(code: number | null, weSignalled: boolean): { exitCode: number | null; signal: string | null } {
  if (code !== null && weSignalled && code > 128 && code < 128 + 65) {
    const n = code - 128;
    return { exitCode: null, signal: SIGNAL_NAMES[n] ?? `SIG${n}` };
  }
  return { exitCode: code, signal: null };
}
