import type { ImageContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { type LlmModelConfig, REASONING_EFFORTS, type ReasoningEffort, thinkingLevelOf } from "../agent/runtime.js";
import type { AuthResult } from "../auth/auth.js";
import { apiError, badRequest, validationError } from "../errors.js";
import { checkImage } from "../tools/image-guard.js";

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
    background: z.boolean().nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    user: z.string().nullish(),
    reasoning: z.object({ effort: z.string().nullish() }).passthrough().nullish(),
    /** false면 사용자에게 묻는 도구(AskUserQuestion 등)를 뺀다. 사용자가 답할 수 없는 요청용. 기본 true */
    interactive: z.boolean().nullish(),
    /** true면 sandbox를 바꾸거나 명령을 실행하는 도구(write·edit·bash, sandbox MCP 서버)를 뺀다. 남이 쓴 내용이 이 사용자의 sandbox를 움직이는 요청용. 기본 false */
    read_only: z.boolean().nullish(),
    /** 이번 턴의 bash에 넣을 환경변수 (서비스 키 전용). 메모리에만 두고 매 요청 새로 받는다 (sandboxEnvOf 참고). */
    sandbox_env: z.record(z.string(), z.string()).nullish(),
    text: z
      .object({
        format: z
          .object({ type: z.string(), name: z.string().nullish(), schema: z.record(z.string(), z.unknown()).nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
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

/** `text.format` json_schema. 스키마는 StructuredOutput 도구의 인자가 되므로 최상위가 object여야 한다. */
export interface OutputFormat {
  name: string | null;
  schema: Record<string, unknown>;
}

export function outputFormatOf(body: ResponseCreateRequest): OutputFormat | null {
  const format = body.text?.format;
  if (!format || format.type === "text") return null;
  if (format.type !== "json_schema") throw badRequest(`text.format '${format.type}' is not supported`);
  if (!format.schema || format.schema.type !== "object") throw badRequest("text.format.schema must be a JSON schema with type 'object'");
  return { name: format.name ?? null, schema: format.schema };
}

/** sandbox_env 상한. 비밀값 몇 개를 넘기는 용도라 넉넉히 잡는다. */
const SANDBOX_ENV_MAX_NAMES = 64;
const SANDBOX_ENV_MAX_BYTES = 256 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** sandbox가 쓰는 이름(프록시·경로·셸 동작)은 덮어쓰지 못한다. 대소문자는 가리지 않는다. */
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|PWD|OLDPWD|TMPDIR|LANG|TERM|IFS|ENV|HOSTNAME|PS4|PROMPT_COMMAND|SHELLOPTS)$|^(LD_|BASH|LC_)|_PROXY$/i;

/**
 * 요청의 sandbox_env. 서비스 키 요청만 쓸 수 있다 (BFF가 사용자 대신 자기 사용자의 비밀값을 넘긴다).
 * 값은 오류 메시지에 싣지 않는다. 없으면 빈 객체 — 그 턴의 bash에는 아무것도 넣지 않는다.
 */
export function sandboxEnvOf(body: ResponseCreateRequest, auth: AuthResult): Record<string, string> {
  const env = body.sandbox_env;
  if (!env || Object.keys(env).length === 0) return {};
  if (auth.kind !== "service") {
    throw apiError(403, "sandbox_env can only be sent with the service API key", { type: "invalid_request_error", code: "sandbox_env_not_allowed" });
  }
  const names = Object.keys(env);
  if (names.length > SANDBOX_ENV_MAX_NAMES) throw badRequest(`sandbox_env accepts at most ${SANDBOX_ENV_MAX_NAMES} names`);
  let bytes = 0;
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw badRequest(`sandbox_env name '${name.slice(0, 64)}' is not a valid environment variable name`);
    if (RESERVED_ENV.test(name)) throw badRequest(`sandbox_env name '${name}' is reserved by the sandbox`);
    if (env[name]!.includes("\0")) throw badRequest(`sandbox_env value of '${name}' contains a NUL byte`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(env[name]!);
  }
  if (bytes > SANDBOX_ENV_MAX_BYTES) throw badRequest(`sandbox_env exceeds ${SANDBOX_ENV_MAX_BYTES} bytes`);
  return env;
}

export type ParsedInput =
  | { kind: "prompt"; text: string; images: ImageContent[]; systemText: string | null; hasSystemItems: boolean }
  | { kind: "answer"; callId: string; output: string };

const ROLE_LABELS: Record<string, string> = { user: "User", assistant: "Assistant", system: "System", developer: "Developer" };

type Message = z.infer<typeof MessageItem>;

const DATA_URL = /^data:[^,]*;base64,(.*)$/s;

/** input_image는 base64 data URL만 받는다. gateway가 URL을 대신 가져오지 않는다. */
function inputImage(part: z.infer<typeof ContentPart>): ImageContent {
  const m = typeof part.image_url === "string" ? DATA_URL.exec(part.image_url) : null;
  if (!m) throw badRequest("input_image.image_url must be a base64 data: URL", "unsupported_image_input");
  const buf = Buffer.from(m[1]!, "base64");
  const verdict = checkImage(buf);
  if (!verdict.ok) throw badRequest(`input_image rejected: ${verdict.reason}`, "invalid_image");
  return { type: "image", data: buf.toString("base64"), mimeType: verdict.info.mimeType };
}

/** images를 넘기면 input_image를 거기에 모은다. 넘기지 않으면 (system 메시지) input_image는 400이다. */
function contentText(content: Message["content"], images?: ImageContent[]): string {
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "input_image" && images) {
      images.push(inputImage(part));
      continue;
    }
    if (part.type === "input_image" || part.type === "image" || part.type === "input_file") {
      throw badRequest(`input part type '${part.type}' is not supported here`, "unsupported_image_input");
    }
    if (typeof part.text === "string" && part.text) texts.push(part.text);
  }
  return texts.join("\n");
}

/** 메시지 배열을 프롬프트 하나로 합친다. 메시지가 둘 이상이면 `User: ` 같은 라벨을 붙인다. */
function flatten(messages: Message[], images: ImageContent[]): string {
  const label = messages.length > 1;
  const parts: string[] = [];
  for (const m of messages) {
    const text = contentText(m.content, images);
    if (!text) continue;
    parts.push(label ? `${ROLE_LABELS[m.role]}: ${text}` : text);
  }
  return parts.join("\n\n");
}

export function parseInput(body: ResponseCreateRequest): ParsedInput {
  const input = body.input;
  if (typeof input === "string") {
    if (!input.trim()) throw badRequest("input must not be empty");
    return { kind: "prompt", text: input, images: [], systemText: null, hasSystemItems: false };
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
  const images: ImageContent[] = [];
  const text = flatten(promptMessages, images);
  if (!text.trim() && images.length === 0) throw badRequest("input must not be empty");
  return { kind: "prompt", text, images, systemText, hasSystemItems };
}

/** reasoning.effort → pi thinking level. reasoning 모델이면 모델의 efforts에 있어야 한다. */
export function thinkingLevelFor(effort: string | null | undefined, model: LlmModelConfig): string | undefined {
  if (!effort) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) throw badRequest(`Unsupported reasoning.effort '${effort}'`, "unsupported_reasoning_effort");
  if (!model.reasoning) return "off";
  if (!(model.efforts as string[]).includes(effort)) {
    throw badRequest(`Model '${model.id}' does not support reasoning.effort '${effort}'. Supported: ${model.efforts.join(", ")}`, "unsupported_reasoning_effort");
  }
  return thinkingLevelOf(effort as ReasoningEffort);
}

const RESPONSE_ID = /^resp_([0-9a-f-]{36})_([1-9][0-9]*)$/;

export function parseResponseId(id: string): { sessionId: string; turn: number } | null {
  const m = RESPONSE_ID.exec(id);
  if (!m) return null;
  return { sessionId: m[1]!, turn: Number(m[2]) };
}

export const responseId = (sessionId: string, turn: number) => `resp_${sessionId}_${turn}`;
