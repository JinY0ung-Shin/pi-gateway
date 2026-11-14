import type { AgentSession, AgentSessionEvent, PromptOptions } from "@earendil-works/pi-coding-agent";

/**
 * prompt 한 번(턴 하나)에 실행할 수 있는 도구 호출 수의 기본값. 모델이 같은 호출을 끝없이 반복해도 턴이 끝나게 한다.
 * 관리 화면(기본 도구)에서 바꾼다 (ToolSettings.maxToolCalls).
 */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 200;
/** 관리 화면에서 줄 수 있는 범위 */
export const MAX_TOOL_CALLS_RANGE = { min: 1, max: 10_000 };

/**
 * prompt 한 번을 실행한다. signal이 abort되거나, 모델이 한 도구 호출이 maxToolCalls를 넘으면 세션을 멈춘다
 * (mcp_call이 대신 부른 호출은 따로 실행되지 않아 세지 않는다). onEvent는 prompt 동안만 구독한다.
 * prompt가 던진 오류는 thrown으로 돌려준다.
 */
export async function promptWithLimit(
  session: AgentSession,
  text: string,
  options: PromptOptions,
  run: { maxToolCalls: number; signal?: AbortSignal; onEvent?: (event: AgentSessionEvent) => void },
): Promise<{ limited: boolean; thrown: unknown }> {
  let calls = 0;
  let limited = false;
  const unsubscribe = session.subscribe((event) => {
    run.onEvent?.(event);
    if (event.type === "tool_execution_start" && !limited && ++calls > run.maxToolCalls) {
      limited = true;
      void session.abort();
    }
  });
  const onAbort = () => void session.abort();
  run.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (run.signal?.aborted) throw new Error("aborted");
    await session.prompt(text, options);
    return { limited, thrown: undefined };
  } catch (err) {
    return { limited, thrown: err };
  } finally {
    run.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}
