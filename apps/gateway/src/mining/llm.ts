import { type Api, type Model, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * mining의 LLM 호출: 도구 하나를 주고 그 도구를 부르게 지정한 뒤, 인자를 schema로 검증해서 돌려준다.
 * gateway는 도구에 strict를 붙여 보내지 않으므로 (runtime.ts의 supportsStrictMode), 형식은 서버 설정과 이 검증에 달려 있다.
 */

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 2_000;

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
