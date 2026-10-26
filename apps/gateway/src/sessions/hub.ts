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
  /** 이 세션을 만들 때의 설정 revision (LLM 연결·기본 도구). 설정이 바뀌면 다음 턴에 다시 연다. */
  revision: string;
}

/** 세션을 열면 모델이 받는 것: pi가 조립한 시스템 프롬프트와 요청에 실리는 도구 선언 */
export interface SessionPreview {
  model: string;
  systemPrompt: string;
  tools: { name: string; description: string; parameters: unknown }[];
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
    let existing = this.live.get(record.id);
    if (existing && existing.revision !== this.settingsRevision()) {
      // LLM 설정(주소·키·모델)이나 기본 도구 설정이 바뀌었다. 기록은 JSONL에 있으므로 새 설정으로 다시 연다.
      await this.teardown(existing);
      existing = undefined;
    }
    if (existing) {
      existing.record = record;
      existing.requestContext = requestContext;
      existing.lastActive = Date.now();
      return existing;
    }
    // 도구를 만드는 동안(예: sandbox MCP 서버 목록 조회)에도 이번 요청의 컨텍스트가 보이게 한다.
    const holder: { live?: LiveSession; ctx: RequestContext } = { ctx: requestContext };
    const revision = this.settingsRevision();
    const agent = await buildAgentSession(this.deps.factory, record, () => holder.live?.requestContext ?? holder.ctx, signal);
    const live: LiveSession = { id: record.id, record, agent, requestContext, lastActive: Date.now(), activeTurn: null, revision };
    holder.live = live;
    this.live.set(record.id, live);
    return live;
  }

  /** 기록으로 세션을 열어 프롬프트와 도구만 읽고 바로 정리한다 (메모리·JSONL에 남기지 않는다). */
  async preview(record: SessionRecord): Promise<SessionPreview> {
    const abort = new AbortController();
    const agent = await buildAgentSession(this.deps.factory, record, () => ({}), abort.signal);
    try {
      const { session } = agent;
      return {
        model: record.model,
        systemPrompt: session.systemPrompt,
        tools: session.agent.state.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      };
    } finally {
      await this.teardown({ id: record.id, record, agent, requestContext: {}, lastActive: 0, activeTurn: abort, revision: "" });
    }
  }

  private settingsRevision(): string {
    return `${this.deps.factory.models.revision()}:${this.deps.factory.toolSettings.revision()}`;
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

  /** 보관 기간(관리 화면 설정)이 지난 세션을 지운다. */
  async purgeExpired(now = Date.now()): Promise<void> {
    const { days } = this.deps.store.retention();
    if (days <= 0) return;
    const before = new Date(now - days * 86_400_000).toISOString();
    for (const id of this.deps.store.inactiveSince(before)) {
      if (this.locks.isLocked(id)) continue;
      await this.locks.run(id, async () => {
        // lock을 기다리는 동안 이어진 세션은 남긴다
        const record = this.deps.store.get(id);
        if (!record || record.lastActiveAt >= before) return;
        await this.discardLocked(id);
        this.deps.log.info({ session: id }, "expired session deleted");
      });
    }
  }

  startReaper(intervalMs = 30_000): void {
    this.reaper = setInterval(() => {
      void Promise.all([this.reap(), this.purgeExpired()]).catch((err) => this.deps.log.warn({ err }, "session reaper failed"));
    }, intervalMs);
    this.reaper.unref?.();
  }

  stats(): { liveSessions: number } {
    return { liveSessions: this.live.size };
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
