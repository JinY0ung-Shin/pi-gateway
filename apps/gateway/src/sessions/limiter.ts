import { capacityError } from "../errors.js";

/** 키별 직렬화 락. 대기자가 없으면 키를 지운다. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}

interface Waiter {
  principal: string;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 동시에 실행되는 턴 수 제한 (전역 + 사용자별). 초과분은 FIFO로 기다리고,
 * 시간이 지나거나 대기열이 가득 차면 503 concurrency_limit_exceeded.
 */
export class TurnLimiter {
  private active = 0;
  private readonly perUser = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private closedError: Error | null = null;

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerUser: number,
    private readonly maxWaiters: number,
    private readonly timeoutMs: number,
  ) {}

  private canRun(principal: string): boolean {
    const globalOk = this.maxGlobal <= 0 || this.active < this.maxGlobal;
    const userOk = this.maxPerUser <= 0 || (this.perUser.get(principal) ?? 0) < this.maxPerUser;
    return globalOk && userOk;
  }

  private take(principal: string): () => void {
    this.active++;
    this.perUser.set(principal, (this.perUser.get(principal) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const n = (this.perUser.get(principal) ?? 1) - 1;
      if (n <= 0) this.perUser.delete(principal);
      else this.perUser.set(principal, n);
      this.drain();
    };
  }

  /**
   * 대기열 앞에서부터 실행할 수 있는 대기자를 모두 깨운다.
   * 자기 사용자 한도에 걸린 대기자는 건너뛴다 (다른 사용자를 막지 않게). 전역 한도는 순서대로 적용된다.
   */
  private drain(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i]!;
      if (this.canRun(w.principal)) {
        this.queue.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(this.take(w.principal));
      } else {
        i++;
      }
    }
  }

  async acquire(principal: string, signal?: AbortSignal): Promise<() => void> {
    if (this.closedError) throw this.closedError;
    if (this.queue.length === 0 && this.canRun(principal)) return this.take(principal);
    if (this.queue.length >= this.maxWaiters || this.timeoutMs <= 0) {
      // 대기열이 있어도 이 사용자는 바로 돌 수 있으면 돌린다 (앞의 대기자가 자기 사용자 한도에 걸린 경우).
      if (this.canRun(principal) && this.queue.every((w) => !this.canRun(w.principal))) return this.take(principal);
      throw capacityError();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        principal,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(capacityError());
        }, this.timeoutMs),
      };
      signal?.addEventListener(
        "abort",
        () => {
          if (this.remove(waiter)) {
            clearTimeout(waiter.timer);
            reject(new Error("aborted"));
          }
        },
        { once: true },
      );
      this.queue.push(waiter);
      // 앞의 대기자가 사용자 한도에 걸려 있으면 이 대기자는 바로 돌 수 있다.
      this.drain();
    });
  }

  /** 종료: 기다리는 요청을 모두 거절하고, 새 요청도 거절한다. */
  close(error: Error): void {
    this.closedError = error;
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      w.reject(error);
    }
  }

  private remove(waiter: Waiter): boolean {
    const i = this.queue.indexOf(waiter);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }
}
