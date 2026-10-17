import { rmSync } from "node:fs";
import type { RequestContext } from "@pi-gateway/shared";
import type { Logger } from "pino";
import { type AgentFactoryDeps, type BuiltAgent, buildAgentSession, subagentDirFor } from "../agent/session-factory.js";
import type { GatewayConfig } from "../config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { KeyedMutex } from "./limiter.js";
import type { SessionRecord, SessionStore } from "./store.js";

/**
 * 메모리에 올라와 있는 세션들. 유휴 세션은 정리하고 다음 요청 때 JSONL에서 되살린다.
 * 세션 하나에 대한 작업은 locks.run(sessionId, …) 안에서만 한다.
 */

export interface LiveSession {
  id: string;
  record: SessionRecord;
  agent: BuiltAgent;
  /** 현재 턴 요청의 전달 헤더·metadata. MCP 호출이 이 값을 쓴다. */
  requestContext: RequestContext;
  lastActive: number;
  activeTurn: AbortController | null;
}

export interface SessionHubDeps {
  store: SessionStore;
  factory: AgentFactoryDeps;
  config: GatewayConfig;
  tools: ToolRegistry;
  log: Logger;
}

const ABORT_TIMEOUT_MS = 10_000;

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export class SessionHub {
  readonly locks = new KeyedMutex();
  private readonly live = new Map<string, LiveSession>();
  private reaper: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(private readonly deps: SessionHubDeps) {}

  /**
   * 세션을 메모리에 올리고 이번 요청의 컨텍스트(전달 헤더·metadata)를 붙인다.
   * 호출하는 쪽이 세션 lock을 잡고 있어야 한다.
   */
  async acquire(record: SessionRecord, signal: AbortSignal, requestContext: RequestContext = {}): Promise<LiveSession> {
    const existing = this.live.get(record.id);
    if (existing) {
      existing.record = record;
      existing.requestContext = requestContext;
      existing.lastActive = Date.now();
      return existing;
    }
    // 도구를 만드는 동안(예: sandbox MCP 서버 목록 조회)에도 이번 요청의 컨텍스트가 보이게 한다.
    const holder: { live?: LiveSession; ctx: RequestContext } = { ctx: requestContext };
    const agent = await buildAgentSession(this.deps.factory, record, () => holder.live?.requestContext ?? holder.ctx, signal);
    const live: LiveSession = { id: record.id, record, agent, requestContext, lastActive: Date.now(), activeTurn: null };
    holder.live = live;
    this.live.set(record.id, live);
    return live;
  }

  get(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  /** abort → session_shutdown → dispose → 도구 연결 정리 (pi dispose는 앞의 두 단계를 하지 않는다) */
  private async teardown(live: LiveSession): Promise<void> {
    this.live.delete(live.id);
    const { session } = live.agent;
    live.activeTurn?.abort();
    await withTimeout(session.abort(), ABORT_TIMEOUT_MS);
    try {
      const runner = session.extensionRunner;
      if (runner?.hasHandlers("session_shutdown")) {
        await withTimeout(runner.emit({ type: "session_shutdown", reason: "quit" }), ABORT_TIMEOUT_MS);
      }
    } catch (err) {
      this.deps.log.warn({ err, session: live.id }, "session_shutdown handlers failed");
    }
    try {
      session.dispose();
    } catch (err) {
      this.deps.log.warn({ err, session: live.id }, "session dispose failed");
    }
    await this.deps.tools.disposeSession(live.id);
  }

  /** 메모리의 세션만 정리한다 (호출하는 쪽이 lock을 잡고 있어야 한다). 다음 요청 때 JSONL에서 되살린다. */
  async discardLive(id: string): Promise<void> {
    const live = this.live.get(id);
    if (live) await this.teardown(live);
  }

  /** 세션 lock 안에서 메모리의 세션을 정리한다. */
  async evict(id: string): Promise<void> {
    await this.locks.run(id, async () => {
      const live = this.live.get(id);
      if (live) await this.teardown(live);
    });
  }

  /** 세션을 완전히 지운다 (호출하는 쪽이 lock을 잡고 있어야 한다): 메모리, JSONL(하위 agent 포함), 메타. workspace는 사용자의 다른 세션과 공유하므로 남긴다. */
  async discardLocked(id: string): Promise<void> {
    const live = this.live.get(id);
    const record = this.deps.store.get(id) ?? live?.record;
    if (live) await this.teardown(live);
    const file = live?.agent.session.sessionManager.getSessionFile() ?? record?.sessionFile;
    if (file) rmSync(file, { force: true });
    if (record) rmSync(subagentDirFor(this.deps.config, record), { recursive: true, force: true });
    this.deps.store.delete(id);
  }

  async reap(): Promise<void> {
    const now = Date.now();
    const idleMs = this.deps.config.sessions.idleSeconds * 1000;
    for (const live of [...this.live.values()]) {
      if (live.activeTurn || now - live.lastActive < idleMs) continue;
      if (this.locks.isLocked(live.id)) continue;
      await this.evict(live.id);
      this.deps.log.debug({ session: live.id }, "idle session evicted");
    }
  }

  startReaper(intervalMs = 30_000): void {
    this.reaper = setInterval(() => {
      void this.reap().catch((err) => this.deps.log.warn({ err }, "session reaper failed"));
    }, intervalMs);
    this.reaper.unref?.();
  }

  stats(): { liveSessions: number; activeTurns: number } {
    let activeTurns = 0;
    for (const l of this.live.values()) if (l.activeTurn) activeTurns++;
    return { liveSessions: this.live.size, activeTurns };
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 새 턴을 받지 않고, 실행 중인 턴을 중단한다. (이후 HTTP 서버를 닫고 shutdown()을 부른다) */
  beginShutdown(): void {
    this.shuttingDown = true;
    if (this.reaper) clearInterval(this.reaper);
    for (const live of this.live.values()) live.activeTurn?.abort();
  }

  /** 모든 세션을 정리한다. */
  async shutdown(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([...this.live.values()].map((l) => this.teardown(l)));
  }
}
