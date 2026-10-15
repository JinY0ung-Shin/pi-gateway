import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { RenderedTransport } from "../render.js";
import { ProcessStdioTransport } from "./stdio-transport.js";
import { killAllAsUid, reapUid } from "./uid-reaper.js";

export const BROKER_CLIENT_INFO = { name: "pi-gateway-mcp-broker", version: "0.1.0" } as const;

export interface UpstreamConnection {
  readonly client: Client;
  readonly kind: "stdio" | "http";
  readonly pid: number | undefined;
  readonly uid: number | undefined;
  /** 여러 번 불러도 된다. stdio면 process group을 정리하고 작업 디렉토리를 지운다. */
  close(): Promise<void>;
}

export interface StdioRuntime {
  path: string;
  lang: string;
  workRoot: string;
  maxMessageBytes: number;
  uids: UidAllocator | null;
  /** 남은 프로세스를 정리하지 못해 uid를 격리했을 때 */
  onUidQuarantined?: (uid: number) => void;
}

export interface ConnectHooks {
  /** upstream 연결이 스스로 끊겼을 때 (프로세스 종료 등) */
  onClosed(): void;
  onToolsChanged(): void;
  onStderrLine(line: string): void;
}

export interface ConnectOptions {
  connectTimeoutMs: number;
  stdio: StdioRuntime;
  hooks: ConnectHooks;
}

/**
 * stdio 프로세스마다 다른 uid를 준다. 서로의 /proc/<pid>/environ이나 파일을 볼 수 없게 하려는 것이다.
 * uid는 범위를 한 바퀴 돈 뒤에야 다시 쓰고, 돌려받을 때는 그 uid의 프로세스가 모두 사라졌는지 확인한다.
 * 확인하지 못한 uid는 격리해 두고 다시 주지 않는다.
 */
export class UidAllocator {
  readonly #start: number;
  readonly #end: number;
  readonly #inUse = new Set<number>();
  readonly #quarantined = new Set<number>();
  readonly #reap: (uid: number) => Promise<boolean>;
  #next: number;

  constructor(range: { start: number; end: number }, reap: (uid: number) => Promise<boolean> = defaultReap) {
    this.#start = range.start;
    this.#end = range.end;
    this.#next = range.start;
    this.#reap = reap;
  }

  allocate(): number {
    const size = this.#end - this.#start + 1;
    for (let i = 0; i < size; i++) {
      const uid = this.#next;
      this.#next = uid >= this.#end ? this.#start : uid + 1;
      if (!this.#inUse.has(uid) && !this.#quarantined.has(uid)) {
        this.#inUse.add(uid);
        return uid;
      }
    }
    throw new Error("no free uid in BROKER_STDIO_UID_RANGE");
  }

  /**
   * uid의 남은 프로세스를 모두 죽인 뒤 돌려받는다. `beforeRelease`(작업 디렉토리 정리 등)는 그 사이에 실행된다.
   * 프로세스가 남아 있는지 확인하지 못하면 uid를 격리하고 false를 돌려준다.
   */
  async reclaim(uid: number, beforeRelease?: () => Promise<void>): Promise<boolean> {
    let clean = false;
    try {
      clean = await this.#reap(uid);
    } catch {
      clean = false;
    }
    try {
      await beforeRelease?.();
    } finally {
      this.#inUse.delete(uid);
      if (!clean) this.#quarantined.add(uid);
    }
    return clean;
  }

  get used(): number {
    return this.#inUse.size;
  }

  get quarantined(): number {
    return this.#quarantined.size;
  }
}

const defaultReap = (uid: number) => reapUid(uid, { killAllAsUid });

/**
 * 프로세스 작업 디렉토리를 지운다. CAP_DAC_OVERRIDE가 없으면 root도 다른 uid의 0700 디렉토리를
 * 읽을 수 없으므로, 그 uid로 내용을 지운 뒤 빈 디렉토리만 지운다.
 */
async function removeWorkDir(dir: string, uid: number | undefined): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    return;
  } catch {
    if (uid === undefined) return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn("rm", ["-rf", "--", `${dir}/`], { uid, gid: uid, env: { PATH: "/usr/bin:/bin" }, cwd: "/", stdio: "ignore" });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
  await rmdir(dir).catch(() => {});
}

function newClient(hooks: ConnectHooks): Client {
  // sampling·elicitation·roots는 선언하지 않는다 (upstream이 우리에게 되묻는 경로를 막는다).
  const client = new Client({ ...BROKER_CLIENT_INFO }, { capabilities: {} });
  client.setNotificationHandler("notifications/tools/list_changed", () => hooks.onToolsChanged());
  return client;
}

export async function connectUpstream(rendered: RenderedTransport, options: ConnectOptions): Promise<UpstreamConnection> {
  return rendered.type === "stdio" ? connectStdio(rendered, options) : connectHttp(rendered, options);
}

async function connectHttp(
  rendered: Extract<RenderedTransport, { type: "http" }>,
  options: ConnectOptions,
): Promise<UpstreamConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(rendered.url), {
    requestInit: { headers: rendered.headers },
    redirectPolicy: "same-origin",
  });
  const client = newClient(options.hooks);
  let closed = false;
  client.onclose = () => {
    if (!closed) options.hooks.onClosed();
  };
  try {
    await client.connect(transport, { timeout: options.connectTimeoutMs });
  } catch (error) {
    closed = true;
    await client.close().catch(() => {});
    throw error;
  }
  return {
    client,
    kind: "http",
    pid: undefined,
    uid: undefined,
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
    },
  };
}

async function connectStdio(
  rendered: Extract<RenderedTransport, { type: "stdio" }>,
  options: ConnectOptions,
): Promise<UpstreamConnection> {
  const runtime = options.stdio;
  const uid = runtime.uids?.allocate();
  const workDir = join(runtime.workRoot, `p-${randomBytes(8).toString("hex")}`);
  let closed = false;
  const cleanup = async () => {
    // setsid로 process group을 빠져나간 자손까지 uid 기준으로 정리한 뒤 작업 디렉토리를 지우고 uid를 돌려준다.
    if (uid !== undefined && runtime.uids) {
      const clean = await runtime.uids.reclaim(uid, () => removeWorkDir(workDir, uid));
      if (!clean) runtime.onUidQuarantined?.(uid);
    } else {
      await removeWorkDir(workDir, undefined);
    }
  };

  try {
    await mkdir(workDir, { mode: 0o700 });
    if (uid !== undefined) await chown(workDir, uid, uid);
  } catch (error) {
    await cleanup();
    throw error;
  }

  const env: Record<string, string> = {
    PATH: runtime.path,
    HOME: workDir,
    TMPDIR: workDir,
    LANG: runtime.lang,
    ...rendered.env,
  };
  const transport = new ProcessStdioTransport({
    command: rendered.command,
    args: rendered.args,
    env,
    cwd: rendered.cwd ?? workDir,
    ...(uid !== undefined ? { uid, gid: uid } : {}),
    maxMessageBytes: runtime.maxMessageBytes,
    onStderrLine: (line) => options.hooks.onStderrLine(line),
  });
  const client = newClient(options.hooks);
  client.onclose = () => {
    if (!closed) options.hooks.onClosed();
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await cleanup();
  };

  try {
    await client.connect(transport, { timeout: options.connectTimeoutMs });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    client,
    kind: "stdio",
    get pid() {
      return transport.pid;
    },
    uid,
    close,
  };
}
