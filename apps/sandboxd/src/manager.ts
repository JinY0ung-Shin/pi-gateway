import type Docker from "dockerode";
import { type SandboxInfo, userKey } from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { SandboxdConfig } from "./config.js";
import { dockerStatus, errorMessage, SandboxError } from "./errors.js";
import {
  buildContainerSpec,
  containerName,
  LABEL_INSTANCE,
  LABEL_SANDBOX,
  LABEL_SPEC,
  LABEL_USER_KEY,
  SPEC_VERSION,
  USER_KEY_PATTERN,
} from "./spec.js";
import type { Workspaces } from "./workspace.js";

/** 실행 중인지 확인한 결과를 이 시간 동안 믿는다. exec가 실패하면 즉시 다시 확인한다. */
const VERIFY_TTL_MS = 30_000;

interface Entry {
  key: string;
  container: Docker.Container | null;
  verifiedAt: number;
  lastActive: number;
  inflight: number;
}

export interface Lease {
  key: string;
  container: Docker.Container;
  /** 이번 acquire에서 컨테이너를 새로 만들었는지 */
  created: boolean;
  release(): void;
  /** 컨테이너가 사라진 것 같을 때: 다음 acquire에서 다시 확인하게 한다 */
  invalidate(): void;
}

/**
 * 사용자별 sandbox 컨테이너의 수명주기. 같은 사용자에 대한 생성·삭제·정리는 직렬로 처리한다.
 * 진행 중인 작업(inflight)이 있는 컨테이너는 정리하지 않는다.
 */
export class SandboxManager {
  private readonly entries = new Map<string, Entry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private reaper: NodeJS.Timeout | undefined;
  private reaping = false;

  constructor(
    private readonly docker: Docker,
    private readonly config: SandboxdConfig,
    private readonly workspaces: Workspaces,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { key, container: null, verifiedAt: 0, lastActive: this.now(), inflight: 0 };
      this.entries.set(key, e);
    }
    return e;
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async acquire(principal: string): Promise<Lease> {
    const key = userKey(principal);
    const e = this.entry(key);
    e.inflight++;
    e.lastActive = this.now();
    try {
      const { container, created } = await this.serialize(key, () => this.ensureLocked(e));
      let released = false;
      return {
        key,
        container,
        created,
        release: () => {
          if (released) return;
          released = true;
          e.inflight = Math.max(0, e.inflight - 1);
          e.lastActive = this.now();
        },
        invalidate: () => {
          e.verifiedAt = 0;
        },
      };
    } catch (err) {
      e.inflight = Math.max(0, e.inflight - 1);
      throw err;
    }
  }

  private async ensureLocked(e: Entry): Promise<{ container: Docker.Container; created: boolean }> {
    if (e.container && this.now() - e.verifiedAt < VERIFY_TTL_MS) return { container: e.container, created: false };
    const name = containerName(this.config, e.key);
    const existing = this.docker.getContainer(name);
    let running = false;
    let exists = false;
    try {
      const info = await existing.inspect();
      exists = true;
      // 스펙 버전이 다른 컨테이너는 실행 중이어도 쓰지 않는다
      running = info.State?.Running === true && info.State?.Paused !== true && info.Config?.Labels?.[LABEL_SPEC] === SPEC_VERSION;
    } catch (err) {
      if (dockerStatus(err) !== 404) throw unavailable("inspect", err);
    }
    if (running) {
      e.container = existing;
      e.verifiedAt = this.now();
      return { container: existing, created: false };
    }
    if (exists) {
      // 멈춘 컨테이너와 예전 스펙의 컨테이너는 현재 스펙(이미지·제한·네트워크)으로 다시 만든다
      await existing.remove({ force: true }).catch((err: unknown) => {
        if (dockerStatus(err) !== 404) throw unavailable("remove", err);
      });
    }
    await this.workspaces.ensure(e.key);
    const spec = buildContainerSpec(this.config, e.key);
    let container: Docker.Container;
    try {
      container = await this.docker.createContainer(spec);
    } catch (err) {
      if (dockerStatus(err) !== 409) throw unavailable("create", err);
      container = this.docker.getContainer(name);
    }
    try {
      await container.start();
    } catch (err) {
      if (dockerStatus(err) !== 304) throw unavailable("start", err);
    }
    e.container = container;
    e.verifiedAt = this.now();
    this.log.info({ key: e.key }, "sandbox created");
    return { container, created: true };
  }

  private async removeContainer(key: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(this.config, key)).remove({ force: true });
      this.log.info({ key }, "sandbox removed");
    } catch (err) {
      if (dockerStatus(err) !== 404) throw unavailable("remove", err);
    }
  }

  private labelFilter(): Record<string, string[]> {
    return { label: [`${LABEL_SANDBOX}=1`, `${LABEL_INSTANCE}=${this.config.instance}`] };
  }

  async list(): Promise<SandboxInfo[]> {
    const containers = await this.docker.listContainers({ all: true, filters: this.labelFilter() });
    return containers.map((c) => {
      const key = c.Labels?.[LABEL_USER_KEY] ?? "";
      const e = this.entries.get(key);
      const info: SandboxInfo = {
        key,
        containerName: (c.Names?.[0] ?? "").replace(/^\//, ""),
        state: c.State === "running" ? "running" : "stopped",
      };
      if (e) info.lastActiveAt = new Date(e.lastActive).toISOString();
      return info;
    });
  }

  /**
   * 시작할 때와 정리 주기마다 Docker 상태와 맞춘다.
   * 실행 중인데 모르는 컨테이너는 지금 활동한 것으로 보고 채택하고(유휴 시간이 지나면 정리된다),
   * 멈춘 컨테이너, 예전 스펙의 컨테이너(업그레이드 전에 만든 것), key가 이상한 컨테이너는 지운다.
   */
  async reconcile(): Promise<void> {
    const containers = await this.docker.listContainers({ all: true, filters: this.labelFilter() });
    for (const c of containers) {
      const key = c.Labels?.[LABEL_USER_KEY] ?? "";
      const handle = this.docker.getContainer(c.Id);
      if (!USER_KEY_PATTERN.test(key)) {
        await handle.remove({ force: true }).catch(() => undefined);
        continue;
      }
      if (c.State !== "running" || c.Labels?.[LABEL_SPEC] !== SPEC_VERSION) {
        // 만드는 중인 컨테이너(state=created)를 지우지 않도록 같은 key의 작업과 직렬로 처리한다
        await this.serialize(key, async () => {
          const e = this.entries.get(key);
          if (e && e.inflight > 0) return;
          await handle.remove({ force: true }).catch(() => undefined);
          if (e) e.verifiedAt = 0;
        });
        continue;
      }
      if (!this.entries.has(key)) {
        const e = this.entry(key);
        e.container = handle;
        e.verifiedAt = this.now();
        this.log.info({ key }, "adopted running sandbox");
      }
    }
  }

  /** 유휴 컨테이너를 정리한다. workspace는 남긴다. */
  async reapOnce(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      await this.reconcile().catch((err: unknown) => this.log.warn({ err: errorMessage(err) }, "reconcile failed"));
      const idleMs = this.config.idleSeconds * 1000;
      for (const e of [...this.entries.values()]) {
        if (e.inflight > 0 || this.now() - e.lastActive < idleMs) continue;
        await this.serialize(e.key, async () => {
          if (e.inflight > 0 || this.now() - e.lastActive < idleMs) return;
          await this.removeContainer(e.key);
          if (this.entries.get(e.key) === e) this.entries.delete(e.key);
          this.log.info({ key: e.key }, "idle sandbox reaped");
        }).catch((err: unknown) => this.log.warn({ key: e.key, err: errorMessage(err) }, "reap failed"));
      }
    } finally {
      this.reaping = false;
    }
  }

  startReaper(): void {
    this.stopReaper();
    this.reaper = setInterval(() => void this.reapOnce(), this.config.reapIntervalMs);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
  }

  /** 테스트·관리용 */
  activity(key: string): { inflight: number; lastActive: number } | undefined {
    const e = this.entries.get(key);
    return e ? { inflight: e.inflight, lastActive: e.lastActive } : undefined;
  }
}

function unavailable(op: string, err: unknown): SandboxError {
  return new SandboxError("sandbox_unavailable", `docker ${op} failed: ${errorMessage(err)}`);
}
