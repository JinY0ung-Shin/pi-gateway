import type { ImageContent } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type { LiveSession } from "../sessions/hub.js";
import type { PendingToolCall } from "../sessions/store.js";
import type { ResponseEventMapper } from "./mapper.js";

/**
 * 턴 하나를 실행한다: session.prompt() → 이벤트를 mapper로 → 결과 판정.
 * commit 여부는 호출하는 쪽이 결과를 보고 정한다.
 */

export type TurnStatus = "completed" | "incomplete" | "requires_action" | "failed" | "aborted";

export interface TurnOutcome {
  status: TurnStatus;
  error?: { code: string; message: string };
  incompleteReason?: string;
  pending?: PendingToolCall;
  /** 턴 시작 전 pi leaf (commit하지 않을 때 여기로 되돌린다) */
  leafBefore: string | null;
}

/** upstream 오류 메시지 → oh-my-gateway 오류 코드 */
function classifyError(message: string): string {
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limit";
  return "sdk_error";
}

export async function executeTurn(input: {
  live: LiveSession;
  text: string;
  images: ImageContent[];
  expandTemplates: boolean;
  mapper: ResponseEventMapper;
  signal: AbortSignal;
  log: Logger;
}): Promise<TurnOutcome> {
  const { live, mapper, signal, log } = input;
  const session = live.agent.session;
  const leafBefore = session.sessionManager.getLeafId();
  const unsubscribe = session.subscribe((event) => {
    // 리스너는 동기로 불린다. 여기서 던지면 실행이 깨질 수 있으므로 잡는다.
    try {
      mapper.handle(event);
    } catch (err) {
      log.error({ err, event: event.type }, "response event mapping failed");
    }
  });
  const onAbort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let thrown: unknown;
  try {
    if (signal.aborted) throw new Error("aborted");
    await session.prompt(input.text, { expandPromptTemplates: input.expandTemplates, images: input.images });
  } catch (err) {
    thrown = err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
  }

  if (signal.aborted) return { status: "aborted", leafBefore };
  if (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    log.warn({ err: thrown }, "turn failed before completion");
    return { status: "failed", error: { code: classifyError(message), message }, leafBefore };
  }
  if (mapper.pending) return { status: "requires_action", pending: mapper.pending, leafBefore };
  const last = mapper.lastAssistant;
  if (!last) return { status: "failed", error: { code: "empty_response", message: "No response generated" }, leafBefore };
  switch (last.stopReason) {
    case "error": {
      const message = last.errorMessage ?? "upstream model error";
      return { status: "failed", error: { code: classifyError(message), message }, leafBefore };
    }
    case "aborted":
      return { status: "aborted", leafBefore };
    case "length":
      return { status: "incomplete", incompleteReason: "max_output_tokens", leafBefore };
    default:
      // 텍스트도 reasoning도 없는 응답은 성공으로 끝내지 않는다 (oh-my-gateway와 같다: empty_response, commit 안 함).
      if (!mapper.hasOutput()) return { status: "failed", error: { code: "empty_response", message: "No response generated" }, leafBefore };
      if (live.record.outputFormat && !mapper.structuredOutput) {
        return { status: "failed", error: { code: "structured_output_missing", message: "Model ended without calling StructuredOutput" }, leafBefore };
      }
      return { status: "completed", leafBefore };
  }
}

/** commit하지 않는 턴의 기록을 버린다: pi leaf를 턴 시작 전으로 되돌린다. */
export function rewindTurn(live: LiveSession, leafBefore: string | null): void {
  const session = live.agent.session;
  const sm = session.sessionManager;
  if (sm.getLeafId() === leafBefore) return;
  if (leafBefore === null) sm.resetLeaf();
  else sm.branch(leafBefore);
  session.refreshContext();
}
