import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { type JSONRPCMessage, ReadBuffer, serializeMessage, type Transport } from "@modelcontextprotocol/client";

export interface StdioSpawnSpec {
  command: string;
  args: string[];
  /** 자식 프로세스가 보는 env 전체. process.env를 물려주지 않는다. */
  env: Record<string, string>;
  cwd: string;
  uid?: number;
  gid?: number;
  maxMessageBytes: number;
  /** stderr 한 줄마다 호출된다 (호출하는 쪽에서 가리고 로그에 남긴다). */
  onStderrLine?: (line: string) => void;
  /** SIGTERM 뒤 SIGKILL까지 기다리는 시간 */
  killGraceMs?: number;
}

const MAX_STDERR_LINE = 4096;

/**
 * 자식 프로세스를 새 process group(세션)으로 띄우는 stdio 전송.
 * SDK의 StdioClientTransport는 직계 자식에게만 신호를 보내서, 그 아래 프로세스가 남는다.
 * 여기서는 group 전체에 SIGTERM → SIGKILL을 보낸다.
 */
export class ProcessStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly #spec: StdioSpawnSpec;
  readonly #readBuffer: ReadBuffer;
  #child: ChildProcess | undefined;
  #exited = false;
  #closeEmitted = false;
  #stderrRemainder = "";

  constructor(spec: StdioSpawnSpec) {
    this.#spec = spec;
    this.#readBuffer = new ReadBuffer({ maxBufferSize: spec.maxMessageBytes });
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get exited(): boolean {
    return this.#exited;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error("transport already started");
    const spec = this.#spec;
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      ...(spec.uid !== undefined ? { uid: spec.uid } : {}),
      ...(spec.gid !== undefined ? { gid: spec.gid } : {}),
    });
    this.#child = child;

    child.on("exit", () => {
      this.#exited = true;
      this.#emitClose();
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.#readBuffer.append(chunk);
        for (;;) {
          const message = this.#readBuffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        // 메시지 한도 초과나 JSON 파싱 실패: 연결을 계속 쓸 수 없다.
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => this.#onStderr(text));
    child.stdin!.on("error", (error) => this.onerror?.(error));
    child.stdout!.on("error", (error) => this.onerror?.(error));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.#exited = true;
        reject(error);
      });
    });
    child.on("error", (error) => this.onerror?.(error));
  }

  #onStderr(text: string): void {
    const data = this.#stderrRemainder + text;
    const lines = data.split(/\r?\n/);
    this.#stderrRemainder = (lines.pop() ?? "").slice(-MAX_STDERR_LINE);
    for (const line of lines) if (line) this.#spec.onStderrLine?.(line.slice(0, MAX_STDERR_LINE));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (!stdin || this.#exited || stdin.destroyed) throw new Error("stdio transport is not connected");
    const ok = stdin.write(serializeMessage(message));
    if (!ok) await once(stdin, "drain");
  }

  /** process group 전체를 정리한다. 여러 번 불러도 된다. */
  async close(): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#emitClose();
      return;
    }
    child.stdin?.end();
    if (!this.#exited && child.pid !== undefined) {
      this.#signalGroup(child.pid, "SIGTERM");
      const exited = await waitForExit(child, this.#spec.killGraceMs ?? 3000);
      // 직계 자식이 끝나도 group에 남은 프로세스가 있을 수 있다.
      this.#signalGroup(child.pid, "SIGKILL");
      if (!exited) await waitForExit(child, 2000);
    } else if (child.pid !== undefined) {
      this.#signalGroup(child.pid, "SIGKILL");
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    this.#readBuffer.clear();
    this.#emitClose();
  }

  #signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // 이미 끝났거나(ESRCH) 권한이 없다(EPERM — CAP_KILL 없이 다른 uid).
    }
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.onclose?.();
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
