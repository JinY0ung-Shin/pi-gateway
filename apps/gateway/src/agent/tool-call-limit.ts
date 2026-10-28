import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** prompt 한 번(턴 하나)에 실행할 수 있는 도구 호출 수. 모델이 같은 호출을 끝없이 반복해도 턴이 끝나게 한다. */
export const MAX_TOOL_CALLS_PER_TURN = 200;

/**
 * prompt 동안 모델이 한 도구 호출을 세다가 상한을 넘으면 세션을 멈춘다 (mcp_call이 대신 부른 호출은 세지 않는다).
 * 돌려준 함수는 구독을 끊고 상한에 걸렸는지 알려 준다 (prompt가 끝난 뒤 부른다).
 */
export function limitToolCalls(session: AgentSession): () => boolean {
  let calls = 0;
  let hit = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "tool_execution_start" || event.parentToolCallId || hit) return;
    if (++calls > MAX_TOOL_CALLS_PER_TURN) {
      hit = true;
      void session.abort();
    }
  });
  return () => {
    unsubscribe();
    return hit;
  };
}
