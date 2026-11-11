import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { failSpan, type Span, startSpan, withSpan } from "@pi-gateway/shared";

/**
 * pi 세션의 trace span (packages/shared/src/tracing.ts). 턴 span(api/turn.ts) 아래에 LLM 호출과 도구 실행이 달린다.
 * 하위 agent의 LLM 호출·도구 실행은 그것을 부른 Agent·SendMessage 도구 span 아래에 달린다.
 */

/** 도구 실행을 span으로 감싼다. sandboxd·mcp-broker로 가는 요청이 이 span의 자식으로 이어진다. */
export function tracedTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      withSpan(
        `execute_tool ${tool.name}`,
        { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": tool.name, "gen_ai.tool.call.id": toolCallId },
        async (span) => {
          const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
          if ((result as { isError?: boolean }).isError) failSpan(span, "tool_error");
          return result;
        },
      ),
  };
}

/**
 * 세션 이벤트 리스너: LLM 호출마다 span 하나 (pi의 turn_start부터 assistant 메시지가 끝날 때까지).
 * 리스너는 prompt()를 부른 실행 흐름 안에서 동기로 불리므로, span은 그때 실행 중인 span의 자식이 된다.
 */
export function chatSpans(model: string): (event: AgentSessionEvent) => void {
  let span: Span | undefined;
  let startedAt = 0;
  let firstToken = false;
  const end = () => {
    span?.end();
    span = undefined;
  };
  return (event) => {
    if (event.type === "turn_start") {
      end();
      span = startSpan(`chat ${model}`, { "gen_ai.operation.name": "chat", "gen_ai.request.model": model });
      startedAt = Date.now();
      firstToken = false;
    } else if (event.type === "message_update" && span && !firstToken) {
      firstToken = true;
      span.setAttribute("pi_gateway.first_token_ms", Date.now() - startedAt);
    } else if (event.type === "message_end" && span && event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      span.setAttributes({
        "gen_ai.usage.input_tokens": message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
        "gen_ai.usage.cache_read.input_tokens": message.usage.cacheRead,
        "gen_ai.usage.output_tokens": message.usage.output,
        "gen_ai.response.finish_reasons": [message.stopReason],
      });
      if (message.stopReason === "error") failSpan(span, "model_error");
      end();
    } else if (event.type === "agent_end") {
      // assistant 메시지 없이 끝난 실행 (중단 등)
      end();
    }
  };
}
