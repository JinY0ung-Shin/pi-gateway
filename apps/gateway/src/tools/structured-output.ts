import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OutputFormat } from "../api/request.js";

/**
 * StructuredOutput — `text.format` json_schema를 지원한다 (Claude SDK의 output_format과 같은 방식).
 * pi에는 최종 답의 스키마를 정하는 옵션이 없어서, 요청의 스키마를 인자로 받는 도구를 세션에 붙이고 마지막에 부르게 한다.
 * 인자는 pi가 스키마로 검증하고, 맞지 않으면 오류를 받은 모델이 다시 부른다. 호출되면 `terminate: true`로 턴을 끝낸다.
 */

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export const STRUCTURED_OUTPUT_PROMPT =
  `Deliver your final answer by calling the ${STRUCTURED_OUTPUT_TOOL} tool with arguments that match its schema. ` +
  "Do not write the answer as plain text.";

export function createStructuredOutputTool(format: OutputFormat): ToolDefinition {
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    label: "Structured output",
    description:
      `Return the final answer${format.name ? ` (${format.name})` : ""} as structured data. ` +
      "Call this exactly once, after any other tools, as the last step of your turn.",
    parameters: format.schema as unknown as ToolDefinition["parameters"],
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Structured output received." }],
        details: { output: params },
        terminate: true,
      };
    },
  };
}
