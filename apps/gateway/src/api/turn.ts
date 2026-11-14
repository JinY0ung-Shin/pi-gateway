import type { ImageContent } from "@earendil-works/pi-ai";
import { failSpan, withSpan } from "@pi-gateway/shared";
import type { Logger } from "pino";
import { promptWithLimit } from "../agent/tool-call-limit.js";
import type { LiveSession } from "../sessions/hub.js";
import type { PendingToolCall } from "../sessions/store.js";
import type { ResponseEventMapper } from "./mapper.js";

/**
 * 턴 하나를 실행한다: session.prompt() → 이벤트를 mapper로 → 결과 판정.
 * commit 여부는 호출하는 쪽이 결과를 보고 정한다.
 */

type TurnStatus = "completed" | "incomplete" | "requires_action" | "failed" | "aborted";

export interface TurnOutcome {
  status: TurnStatus;
  error?: { code: string; message: string };
  incompleteReason?: string;
  pending?: PendingToolCall;
}

/** upstream 오류 메시지 → oh-my-gateway 오류 코드 */
export function classifyError(message: string): string {
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limit";
  return "sdk_error";
}

interface TurnInput {
  live: LiveSession;
  text: string;
  images: ImageContent[];
  expandTemplates: boolean;
  mapper: ResponseEventMapper;
  /** 이 턴에서 모델이 부를 수 있는 도구 호출 수 */
  maxToolCalls: number;
  signal: AbortSignal;
  log: Logger;
}

/** 턴 전체가 trace 하나다. 관리 화면의 대화 기록이 세션 id로 찾는다 (admin/routes-history.ts). */
export function executeTurn(input: TurnInput): Promise<TurnOutcome> {
  const { record } = input.live;
  return withSpan(
    "invoke_agent",
    { "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": record.id, "gen_ai.request.model": record.model, "pi_gateway.turn": record.turn + 1 },
    async (span) => {
      const outcome = await runTurn(input);
      span.setAttribute("pi_gateway.status", outcome.status);
      if (outcome.status === "failed") failSpan(span, outcome.error?.code ?? "failed");
      return outcome;
    },
  );
}

async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { live, mapper, signal, log } = input;
  const { limited, thrown } = await promptWithLimit(
    live.session,
    input.text,
    { expandPromptTemplates: input.expandTemplates, images: input.images },
    {
      maxToolCalls: input.maxToolCalls,
      signal,
      // 리스너는 동기로 불린다. 여기서 던지면 실행이 깨질 수 있으므로 잡는다.
      onEvent: (event) => {
        try {
          mapper.handle(event);
        } catch (err) {
          log.error({ err, event: event.type }, "response event mapping failed");
        }
      },
    },
  );

  if (signal.aborted) return { status: "aborted" };
  // 상한에 걸려 멈춘 턴은 취소처럼 그때까지의 내용을 남기고 incomplete로 끝낸다.
  if (limited) return { status: "incomplete", incompleteReason: "max_tool_calls" };
  if (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    log.warn({ err: thrown }, "turn failed before completion");
    return { status: "failed", error: { code: classifyError(message), message } };
  }
  if (mapper.pending) return { status: "requires_action", pending: mapper.pending };
  const last = mapper.lastAssistant;
  if (!last) return { status: "failed", error: { code: "empty_response", message: "No response generated" } };
  switch (last.stopReason) {
    case "error": {
      const message = last.errorMessage ?? "upstream model error";
      return { status: "failed", error: { code: classifyError(message), message } };
    }
    case "aborted":
      return { status: "aborted" };
    case "length":
      return { status: "incomplete", incompleteReason: "max_output_tokens" };
    default:
      // 텍스트도 reasoning도 없는 응답은 성공으로 끝내지 않는다 (oh-my-gateway와 같다: empty_response, commit 안 함).
      if (!mapper.hasOutput()) return { status: "failed", error: { code: "empty_response", message: "No response generated" } };
      if (live.record.outputFormat && !mapper.structuredOutput) {
        return { status: "failed", error: { code: "structured_output_missing", message: "Model ended without calling StructuredOutput" } };
      }
      return { status: "completed" };
  }
}

/** pi leaf를 옮긴다: 이어갈 turn의 끝으로, 또는 commit하지 않는 턴을 버리려고 턴 시작 전으로. */
export function moveLeaf(live: LiveSession, leafId: string | null): void {
  const session = live.session;
  const sm = session.sessionManager;
  if (sm.getLeafId() === leafId) return;
  if (leafId === null) sm.resetLeaf();
  else sm.branch(leafId);
  session.refreshContext();
}
