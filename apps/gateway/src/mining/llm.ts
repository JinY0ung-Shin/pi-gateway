import { type Api, type Model, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import type { Working } from "./store.js";

/**
 * mining의 LLM 호출: 도구 하나를 주고 그 도구를 부르게 지정한 뒤, 인자를 schema로 검증해서 돌려준다.
 * gateway는 도구에 strict를 붙여 보내지 않으므로 (runtime.ts의 supportsStrictMode), 형식은 서버 설정과 이 검증에 달려 있다.
 */

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 2_000;
/** LLM 호출이 이만큼 연달아 실패하면 실행을 끝낸다 (LLM 서버 장애) */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface Llm {
  /** 모델 id (보고서에 적는다) */
  readonly model: string;
  /** 한 번 다시 해 보고, 그래도 안 되면 LlmError를 던진다. */
  call<T>(tool: Tool, system: string, user: string): Promise<T>;
}

/** message에는 모델이 쓴 글을 넣지 않는다 (로그에 남는다). */
export class LlmError extends Error {}

export function createLlm(runtime: ModelRuntime, model: Model<Api>, maxTokens: number): Llm {
  // 이름을 지정한 tool choice는 API마다 모양이 다르다.
  const toolChoice = (name: string) => (model.api === "anthropic-messages" ? { type: "tool", name } : { type: "function", function: { name } });

  async function once<T>(tool: Tool, system: string, user: string): Promise<T> {
    // thinking은 요청하지 않는다 (reasoningEffort를 주지 않으면 꺼진다).
    const reply = await runtime.complete(
      model,
      { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }], tools: [tool] },
      { toolChoice: toolChoice(tool.name), maxTokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS), signal: AbortSignal.timeout(TIMEOUT_MS) } as never,
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new LlmError(`llm_error: ${reply.errorMessage ?? reply.stopReason}`);
    const call = reply.content.find((c) => c.type === "toolCall" && c.name === tool.name);
    if (call?.type !== "toolCall") throw new LlmError("invalid_output: no tool call");
    try {
      return validateToolArguments(tool, call) as T;
    } catch {
      throw new LlmError("invalid_output: arguments do not match the schema");
    }
  }

  return {
    model: model.id,
    async call(tool, system, user) {
      try {
        return await once(tool, system, user);
      } catch {
        return once(tool, system, user);
      }
    },
  };
}

/**
 * 한 번의 실행이 쓰는 LLM 호출 창구. 시간 상한이 지났거나, 연달아 실패했거나, 사람이 중지했으면 더 부르지 않는다.
 * 실패는 던지지 않고 undefined로 돌려준다: 부른 쪽은 그 일을 건너뛰고, stopped가 있으면 단계를 끝낸다.
 */
export class Caller {
  stopped: "time_limit" | "aborted" | "stopped" | undefined;
  /** 지금 보내 둔 호출들이 다루는 것 */
  readonly working = new Set<Working>();
  #failures = 0;

  constructor(
    private readonly llm: Llm,
    private readonly deadline: number,
    private readonly now: () => number,
    private readonly log: Logger,
    /** concurrency: each가 동시에 돌리는 수. stop: 사람이 중지를 요청했는가 (호출 앞에서 묻는다). onCall: 호출을 보낼 때마다 불린다 */
    private readonly limits: { concurrency?: number; stop?: () => boolean; onCall?: () => void } = {},
  ) {}

  /** items를 동시에 concurrency개씩 처리한다. 멈춘 뒤에는 남은 것을 시작하지 않는다. */
  async each<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length && !this.stopped) await fn(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.concurrency ?? 1, items.length) }, worker));
  }

  /** about: 이 호출이 다루는 것 (세션·에피소드·라벨 id). 진행 상황과 실패 로그에 쓴다. 대화 내용은 넣지 않는다. */
  async call<T>(tool: Tool, system: string, user: string, about: Working): Promise<T | undefined> {
    if (this.stopped) return undefined;
    if (this.limits.stop?.()) {
      this.stopped = "stopped";
      return undefined;
    }
    if (this.now() >= this.deadline) {
      this.stopped = "time_limit";
      return undefined;
    }
    this.working.add(about);
    this.limits.onCall?.();
    try {
      const out = await this.llm.call<T>(tool, system, user);
      this.#failures = 0;
      return out;
    } catch (err) {
      this.log.warn({ ...about, tool: tool.name, err: err instanceof Error ? err.message : String(err) }, "LLM call failed");
      if (++this.#failures >= MAX_CONSECUTIVE_FAILURES) this.stopped = "aborted";
      return undefined;
    } finally {
      this.working.delete(about);
    }
  }
}
