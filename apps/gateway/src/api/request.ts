import { z } from "zod";
import { badRequest, validationError } from "../errors.js";

/** POST /v1/responses 요청 — oh-my-gateway가 받던 필드 중 v1이 지원하는 것 */

const ContentPart = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

const MessageItem = z
  .object({
    type: z.literal("message").optional(),
    role: z.enum(["user", "assistant", "system", "developer"]),
    content: z.union([z.string(), z.array(ContentPart)]).default(""),
  })
  .passthrough();

const FunctionCallOutputItem = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string().min(1),
    output: z.string(),
  })
  .passthrough();

export const ResponseCreateRequest = z
  .object({
    model: z.string().min(1).optional(),
    input: z.union([z.string(), z.array(z.union([FunctionCallOutputItem, MessageItem]))]),
    instructions: z.string().nullish(),
    previous_response_id: z.string().nullish(),
    stream: z.boolean().nullish(),
    store: z.boolean().nullish(),
    background: z.boolean().nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    user: z.string().nullish(),
    reasoning: z.object({ effort: z.string().nullish() }).passthrough().nullish(),
    text: z.object({ format: z.object({ type: z.string() }).passthrough().nullish() }).passthrough().nullish(),
    temperature: z.number().nullish(),
    max_output_tokens: z.number().nullish(),
  })
  .passthrough();
export type ResponseCreateRequest = z.infer<typeof ResponseCreateRequest>;

export function parseRequest(body: unknown): ResponseCreateRequest {
  const parsed = ResponseCreateRequest.safeParse(body);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        loc: ["body", ...issue.path.map(String)],
        msg: issue.message,
        type: issue.code,
      })),
    );
  }
  return parsed.data;
}

export type ParsedInput =
  | { kind: "prompt"; text: string; systemText: string | null; hasSystemItems: boolean }
  | { kind: "answer"; callId: string; output: string };

const ROLE_LABELS: Record<string, string> = { user: "User", assistant: "Assistant", system: "System", developer: "Developer" };

type Message = z.infer<typeof MessageItem>;

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "input_image" || part.type === "image" || part.type === "input_file") {
      throw badRequest(`input part type '${part.type}' is not supported yet`, "unsupported_image_input");
    }
    if (typeof part.text === "string" && part.text) texts.push(part.text);
  }
  return texts.join("\n");
}

/** 메시지 배열을 프롬프트 하나로 합친다. 메시지가 둘 이상이면 `User: ` 같은 라벨을 붙인다. */
function flatten(messages: Message[]): string {
  const label = messages.length > 1;
  const parts: string[] = [];
  for (const m of messages) {
    const text = contentText(m.content);
    if (!text) continue;
    parts.push(label ? `${ROLE_LABELS[m.role]}: ${text}` : text);
  }
  return parts.join("\n\n");
}

export function parseInput(body: ResponseCreateRequest): ParsedInput {
  const input = body.input;
  if (typeof input === "string") {
    if (!input.trim()) throw badRequest("input must not be empty");
    return { kind: "prompt", text: input, systemText: null, hasSystemItems: false };
  }
  const fco = input.find((item): item is z.infer<typeof FunctionCallOutputItem> => item.type === "function_call_output");
  if (fco) return { kind: "answer", callId: fco.call_id, output: fco.output };

  const messages = input.filter((item): item is Message => item.type !== "function_call_output");
  const hasSystemItems = messages.some((m) => m.role === "system" || m.role === "developer");
  let systemText: string | null = null;
  let promptMessages = messages;
  if (!body.instructions) {
    // instructions가 없으면 마지막 system/developer 메시지가 이 요청의 시스템 지시가 된다.
    const users = messages.filter((m) => m.role !== "system" && m.role !== "developer");
    for (const m of messages) if (m.role === "system" || m.role === "developer") systemText = contentText(m.content);
    if (users.length > 0) promptMessages = users;
  }
  const text = flatten(promptMessages);
  if (!text.trim()) throw badRequest("input must not be empty");
  return { kind: "prompt", text, systemText, hasSystemItems };
}

/** reasoning.effort → pi thinking level */
export function thinkingLevelFor(effort: string | null | undefined, modelReasoning: boolean): string | undefined {
  if (!effort) return undefined;
  const map: Record<string, string> = {
    none: "off",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
  const level = map[effort];
  if (!level) throw badRequest(`Unsupported reasoning.effort '${effort}'`, "unsupported_reasoning_effort");
  if (!modelReasoning) return "off";
  return level;
}

const RESPONSE_ID = /^resp_([0-9a-f-]{36})_([1-9][0-9]*)$/;

export function parseResponseId(id: string): { sessionId: string; turn: number } | null {
  const m = RESPONSE_ID.exec(id);
  if (!m) return null;
  return { sessionId: m[1]!, turn: Number(m[2]) };
}

export const responseId = (sessionId: string, turn: number) => `resp_${sessionId}_${turn}`;
