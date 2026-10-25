import type { Client, Tool } from "@modelcontextprotocol/client";
import type { Logger } from "pino";
import type { RenderedTransport } from "./render.js";
import type { ConnectHooks, UpstreamConnection } from "./upstream/connect.js";

export interface PoolKey {
  serverId: string;
  revision: number;
  /** "shared" | "u:<sub>" | "s:<sub>:<sid>" */
  scopeKey: string;
  /** 렌더링된 transport의 해시. 사용자 토큰이 바뀌면 다른 연결이 된다. */
  renderedHash: string;
}

export interface PoolLimits {
  maxConnections: number;
  idleTtlSeconds: number;
}

export type ConnectFn = (rendered: RenderedTransport, hooks: ConnectHooks) => Promise<UpstreamConnection>;

interface Entry {
  id: string;
  key: PoolKey;
  conn: UpstreamConnection;
  tools: { list: Tool[]; fetchedAt: number } | undefined;
  inflight: number;
  lastUsedAt: number;
  /** 설정이 바뀌어 더 쓰지 않는다. 진행 중인 호출이 끝나면 닫는다. */
  retired: boolean;
  closed: boolean;
}

export interface Lease {
  readonly client: Client;
  cachedTools(maxAgeMs: number): Tool[] | undefined;
  setTools(tools: Tool[]): void;
  release(): void;
}

export class PoolCapacityError extends Error {
  override name = "PoolCapacityError";
}

export class UpstreamBackoffError extends Error {
  override name = "UpstreamBackoffError";
}

const MAX_BACKOFF_MS = 60_000;

function entryId(key: PoolKey): string {
  return `${key.serverId}\u0000${key.revision}\u0000${key.scopeKey}\u0000${key.renderedHash}`;
}

/**
 * upstream 연결 풀.
 * 키가 같으면 같은 연결을 쓰고, 키에는 사용자·세션 범위와 렌더링 결과 해시가 들어간다.
 * 그래서 사용자 A의 헤더 값으로 맺은 연결이 사용자 B에게 쓰이는 일이 없다.
 */
export class UpstreamPool {
  readonly #limits: PoolLimits;
  readonly #connect: ConnectFn;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Entry>>();
  readonly #failures = new Map<string, { count: number; until: number }>();
  readonly #timer: NodeJS.Timeout;
  #closing = false;

  constructor(options: { limits: PoolLimits; connect: ConnectFn; log: Logger; now?: () => number; sweepIntervalMs?: number }) {
    this.#limits = options.limits;
    this.#connect = options.connect;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(() => void this.sweep(), options.sweepIntervalMs ?? 15_000);
    this.#timer.unref();
  }

  async acquire(key: PoolKey, rendered: RenderedTransport): Promise<Lease> {
    if (this.#closing) throw new PoolCapacityError("broker is shutting down");
    this.#retireStale(key.serverId, key.revision);
    const id = entryId(key);

    let entry = this.#entries.get(id);
    if (!entry || entry.closed || entry.retired) {
      entry = await (this.#pending.get(id) ?? this.#create(id, key, rendered));
    }
    entry.inflight++;
    entry.lastUsedAt = this.#now();
    return this.#lease(entry);
  }

  #lease(entry: Entry): Lease {
    let released = false;
    return {
      client: entry.conn.client,
      cachedTools: (maxAgeMs) =>
        entry.tools && this.#now() - entry.tools.fetchedAt <= maxAgeMs ? entry.tools.list : undefined,
      setTools: (tools) => {
        entry.tools = { list: tools, fetchedAt: this.#now() };
      },
      release: () => {
        if (released) return;
        released = true;
        entry.inflight--;
        entry.lastUsedAt = this.#now();
        if (entry.retired && entry.inflight === 0) void this.#close(entry, "retired");
      },
    };
  }

  #create(id: string, key: PoolKey, rendered: RenderedTransport): Promise<Entry> {
    const failure = this.#failures.get(id);
    if (failure && failure.until > this.#now()) {
      return Promise.reject(new UpstreamBackoffError(`upstream ${key.serverId} is backing off after ${failure.count} failed connects`));
    }
    this.#makeRoom(key);

    const promise = (async () => {
      let entry: Entry | undefined;
      const hooks: ConnectHooks = {
        onClosed: () => {
          if (entry && !entry.closed) {
            this.#log.info({ serverId: key.serverId }, "upstream connection closed");
            void this.#close(entry, "upstream closed");
          }
        },
        onToolsChanged: () => {
          if (entry) entry.tools = undefined;
        },
      };
      try {
        const conn = await this.#connect(rendered, hooks);
        entry = {
          id,
          key,
          conn,
          tools: undefined,
          inflight: 0,
          lastUsedAt: this.#now(),
          retired: false,
          closed: false,
        };
        this.#failures.delete(id);
        if (this.#closing) {
          await conn.close();
          throw new PoolCapacityError("broker is shutting down");
        }
        this.#entries.set(id, entry);
        return entry;
      } catch (error) {
        const count = (this.#failures.get(id)?.count ?? 0) + 1;
        this.#failures.set(id, { count, until: this.#now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (count - 1)) });
        throw error;
      } finally {
        this.#pending.delete(id);
      }
    })();
    this.#pending.set(id, promise);
    return promise;
  }

  /** 새 연결을 만들기 전에 한도를 확인하고, 넘으면 오래 쉰 연결부터 닫는다. */
  #makeRoom(key: PoolKey): void {
    const live = () => [...this.#entries.values()].filter((e) => !e.closed);
    while (live().length + this.#pending.size >= this.#limits.maxConnections) {
      const idle = live()
        .filter((e) => e.inflight === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) throw new PoolCapacityError(`upstream capacity reached for ${key.serverId}`);
      void this.#close(idle, "evicted for capacity");
    }
  }

  #retireStale(serverId: string, revision: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.key.serverId === serverId && entry.key.revision < revision) this.#retire(entry);
    }
  }

  #retire(entry: Entry): void {
    entry.retired = true;
    if (entry.inflight === 0) void this.#close(entry, "retired");
  }

  async #close(entry: Entry, reason: string): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    if (this.#entries.get(entry.id) === entry) this.#entries.delete(entry.id);
    this.#log.debug({ serverId: entry.key.serverId, reason }, "closing upstream connection");
    await entry.conn.close().catch((error) => this.#log.warn({ err: String(error) }, "failed to close upstream"));
  }

  /** 서버 설정이 바뀌거나 지워졌을 때. 진행 중인 호출은 끝난 뒤 닫는다. */
  retireServer(serverId: string): void {
    for (const entry of this.#entries.values()) if (entry.key.serverId === serverId) this.#retire(entry);
    for (const id of this.#failures.keys()) if (id.startsWith(`${serverId}\u0000`)) this.#failures.delete(id);
  }

  async sweep(): Promise<void> {
    const cutoff = this.#now() - this.#limits.idleTtlSeconds * 1000;
    const idle = [...this.#entries.values()].filter((e) => e.inflight === 0 && e.lastUsedAt < cutoff);
    await Promise.all(idle.map((e) => this.#close(e, "idle")));
    const now = this.#now();
    for (const [id, failure] of this.#failures) if (failure.until + MAX_BACKOFF_MS < now) this.#failures.delete(id);
  }

  count(serverId?: string): number {
    let n = 0;
    for (const e of this.#entries.values()) if (!e.closed && (serverId === undefined || e.key.serverId === serverId)) n++;
    return n;
  }

  async closeAll(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    await Promise.allSettled([...this.#pending.values()]);
    await Promise.all([...this.#entries.values()].map((e) => this.#close(e, "shutdown")));
  }
}
