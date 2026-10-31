import { randomBytes } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentEventDetails } from "../agent/subagents.js";
import type { McpProgressDetails } from "../mcp-client/connections.js";
import type { PendingToolCall } from "../sessions/store.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import { PRESENT_FILE_TOOL, type PresentedFile } from "../tools/present-file.js";
import { STRUCTURED_OUTPUT_TOOL } from "../tools/structured-output.js";

/**
 * pi AgentSession 이벤트 → OpenAI Responses 출력 항목과 SSE 이벤트.
 * oh-my-gateway의 계약(docs/streaming-events.md)과 같은 순서·형식을 쓴다.
 * emit이 null이면 이벤트를 내보내지 않고 항목만 모은다 (비스트리밍).
 */

export type EmitFn = (type: string, payload: Record<string, unknown>) => void;

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}
export interface MessageItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OutputTextPart[];
}
export interface ReasoningItem {
  id: string;
  type: "reasoning";
  status: "in_progress" | "completed" | "incomplete";
  summary: { type: "summary_text"; text: string }[];
  content?: { type: "reasoning_text"; text: string }[];
}
export interface FunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}
/** present_file로 보여준 workspace 파일. 내용은 `GET /v1/files/content?path=`로 받는다. */
export interface FileItem extends PresentedFile {
  id: string;
  type: "file";
}
export type OutputItem = MessageItem | ReasoningItem | FunctionCallItem | FileItem;

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_creation_tokens: number; context_tokens?: number | null };
  /** 세션 모델의 context window (token). 사용률 표시용 */
  context_window?: number;
}

const hex = () => randomBytes(12).toString("hex");
export const newMessageId = () => `msg_${hex()}`;
export const newReasoningId = () => `rs_${hex()}`;
const newFileId = () => `file_${hex()}`;

export function emptyUsage(): ResponseUsage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 } };
}

export function functionCallItem(call: PendingToolCall): FunctionCallItem {
  return {
    id: `fc_${call.call_id}`,
    type: "function_call",
    call_id: call.call_id,
    name: call.name,
    arguments: JSON.stringify(call.arguments ?? {}),
    status: "completed",
  };
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : c?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** 하위 agent가 부른 도구의 이벤트에 붙이는 부모(Agent·SendMessage) 도구 호출 id */
const tag = (parent: string | undefined) => (parent ? { parent_tool_use_id: parent } : {});

export class ResponseEventMapper {
  /** 완료된 출력 항목 (스트림 순서) */
  readonly items: (MessageItem | ReasoningItem | FileItem)[] = [];
  /** AskUserQuestion이 호출되면 채워진다 */
  pending: PendingToolCall | null = null;
  /** StructuredOutput이 호출되면 그 인자 (응답의 structured_output) */
  structuredOutput: Record<string, unknown> | null = null;
  /** 마지막 assistant 메시지 (결과 판정용) */
  lastAssistant: AssistantMessage | null = null;
  /** 이 턴에서 실행 중인 도구 (keepalive 때 tool_progress를 보낸다). parent는 하위 agent 도구를 부른 부모 도구 호출 */
  readonly running = new Map<string, { name: string; startedAt: number; parent?: string }>();

  private outputIndex = 0;
  private message: { id: string; text: string; outputIndex: number } | null = null;
  private reasoning: { id: string; text: string; outputIndex: number } | null = null;
  private reasoningHold = "";
  private messageEmitted = false;
  private readonly startedTools = new Set<string>();
  private readonly usageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private contextTokens: number | null = null;
  /** assistant 응답 시도가 시작될 때의 상태. pi가 같은 응답을 다시 시도하면 그 시도에서 나온 항목을 버린다. */
  private checkpoint: { items: number; messageId: string | null; messageTextLength: number } | null = null;

  /** contextWindow: 세션 모델의 context window (usage.context_window) */
  constructor(
    private readonly emit: EmitFn | null,
    private readonly contextWindow?: number,
  ) {}

  private send(type: string, payload: Record<string, unknown>): void {
    this.emit?.(type, payload);
  }

  // ── 항목 열고 닫기 ───────────────────────────────────────────────

  private openMessage(): void {
    this.closeReasoning();
    const id = newMessageId();
    this.message = { id, text: "", outputIndex: this.outputIndex };
    this.messageEmitted = true;
    this.send("response.output_item.added", {
      output_index: this.message.outputIndex,
      item: { id, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    this.send("response.content_part.added", {
      item_id: id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private closeMessage(status: "completed" | "incomplete" = "completed"): void {
    const m = this.message;
    if (!m) return;
    const part: OutputTextPart = { type: "output_text", text: m.text, annotations: [] };
    const item: MessageItem = { id: m.id, type: "message", role: "assistant", status, content: [part] };
    this.send("response.output_text.done", { item_id: m.id, output_index: m.outputIndex, content_index: 0, text: m.text, logprobs: [] });
    this.send("response.content_part.done", { item_id: m.id, output_index: m.outputIndex, content_index: 0, part });
    this.send("response.output_item.done", { output_index: m.outputIndex, item });
    this.items.push(item);
    this.message = null;
    this.outputIndex++;
  }

  private openReasoning(): void {
    this.closeMessage();
    const id = newReasoningId();
    this.reasoning = { id, text: "", outputIndex: this.outputIndex };
    this.send("response.output_item.added", {
      output_index: this.reasoning.outputIndex,
      item: { id, type: "reasoning", status: "in_progress", summary: [] },
    });
    this.send("response.reasoning_summary_part.added", {
      item_id: id,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  }

  private closeReasoning(status: "completed" | "incomplete" = "completed"): void {
    this.reasoningHold = "";
    const r = this.reasoning;
    if (!r) return;
    const item: ReasoningItem = {
      id: r.id,
      type: "reasoning",
      status,
      summary: [{ type: "summary_text", text: r.text }],
      content: [{ type: "reasoning_text", text: r.text }],
    };
    this.send("response.reasoning_summary_text.done", { item_id: r.id, output_index: r.outputIndex, summary_index: 0, text: r.text });
    this.send("response.reasoning_text.done", { item_id: r.id, output_index: r.outputIndex, content_index: 0, text: r.text });
    this.send("response.reasoning_summary_part.done", {
      item_id: r.id,
      output_index: r.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: r.text },
    });
    this.send("response.output_item.done", { output_index: r.outputIndex, item });
    this.items.push(item);
    this.reasoning = null;
    this.outputIndex++;
  }

  /** 열린 항목을 모두 닫는다 (턴 끝, AskUserQuestion 일시정지) */
  closeOpenItems(status: "completed" | "incomplete" = "completed"): void {
    this.closeReasoning(status);
    this.closeMessage(status);
  }

  /**
   * 턴을 마무리한다: 열린 항목을 닫고, completed인데 텍스트가 하나도 없었으면
   * 빈 message 항목 하나로 끝낸다 (oh-my-gateway와 같다).
   */
  finalize(status: "completed" | "incomplete"): void {
    this.closeOpenItems(status);
    if (status === "completed" && !this.messageEmitted) {
      this.openMessage();
      this.closeMessage();
    }
  }

  // ── 이벤트 처리 ─────────────────────────────────────────────────

  /**
   * pi가 실패한 응답을 다시 시도한다 (auto retry, 또는 context 초과 시 compaction 후 재시도).
   * 그 시도에서 이미 보낸 delta는 되돌릴 수 없으므로, 열린 항목을 incomplete로 닫고
   * 최종 output에서는 뺀다. 이전 시도부터 이어지던 message 항목은 시도 전 텍스트만 남긴다.
   */
  private discardAttempt(): void {
    const cp = this.checkpoint;
    if (!cp) return;
    const open = this.message;
    this.closeOpenItems("incomplete");
    const added = this.items.splice(cp.items);
    if (open && cp.messageId === open.id && cp.messageTextLength > 0) {
      const item = added.find((i): i is MessageItem => i.id === open.id && i.type === "message");
      if (item) {
        const text = item.content[0]?.text.slice(0, cp.messageTextLength) ?? "";
        this.items.push({ ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
      }
    }
    // 버린 항목의 output_index를 다음 항목이 다시 쓴다: 스트림의 index가 최종 output 배열의 위치와 맞는다.
    this.outputIndex = this.items.length;
    this.checkpoint = null;
  }

  /** 클라이언트에 보여줄 출력(텍스트나 reasoning)이 있었는가 (빈 응답 판정용) */
  hasOutput(): boolean {
    if (this.reasoning || (this.message && this.message.text.length > 0)) return true;
    return this.items.some((i) => i.type !== "message" || i.content.some((c) => c.text.length > 0));
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.checkpoint = { items: this.items.length, messageId: this.message?.id ?? null, messageTextLength: this.message?.text.length ?? 0 };
        }
        return;
      case "auto_retry_start":
        this.discardAttempt();
        return;
      // pi가 대화를 요약하는 동안 클라이언트가 멈춘 것처럼 보이지 않게 알린다.
      case "compaction_start":
        this.send("response.compaction", { status: "in_progress" });
        return;
      case "compaction_end":
        // 요약 뒤의 context 크기 (모르면 비운다). 다음 응답의 usage가 오면 그것으로 바뀐다.
        if (event.result) this.contextTokens = event.result.estimatedTokensAfter ?? null;
        this.send("response.compaction", { status: event.result ? "completed" : "failed" });
        if (event.willRetry) this.discardAttempt();
        return;
      case "message_update": {
        if (event.message.role !== "assistant") return;
        const ae = event.assistantMessageEvent;
        switch (ae.type) {
          case "text_delta":
            if (!ae.delta) return;
            if (!this.message) this.openMessage();
            this.message!.text += ae.delta;
            this.send("response.output_text.delta", {
              item_id: this.message!.id,
              output_index: this.message!.outputIndex,
              content_index: 0,
              delta: ae.delta,
              logprobs: [],
            });
            return;
          case "thinking_delta": {
            if (!ae.delta) return;
            let delta = ae.delta;
            if (!this.reasoning) {
              // 공백만 온 동안은 항목을 열지 않는다.
              this.reasoningHold += delta;
              if (!this.reasoningHold.trim()) return;
              delta = this.reasoningHold;
              this.reasoningHold = "";
              this.openReasoning();
            }
            const r = this.reasoning!;
            r.text += delta;
            this.send("response.reasoning_summary_text.delta", { item_id: r.id, output_index: r.outputIndex, summary_index: 0, delta });
            this.send("response.reasoning_text.delta", { item_id: r.id, output_index: r.outputIndex, content_index: 0, delta });
            return;
          }
          case "thinking_end":
            this.closeReasoning();
            return;
          case "toolcall_start":
          case "toolcall_end":
            this.toolCall(ae);
            return;
          default:
            return;
        }
      }
      case "message_end": {
        if (event.message.role !== "assistant") return;
        const msg = event.message as AssistantMessage;
        this.lastAssistant = msg;
        const u = msg.usage;
        if (u) {
          this.usageSum.input += u.input;
          this.usageSum.output += u.output;
          this.usageSum.cacheRead += u.cacheRead;
          this.usageSum.cacheWrite += u.cacheWrite;
          const ctx = u.input + u.cacheRead + u.cacheWrite;
          if (ctx > 0) this.contextTokens = ctx;
        }
        return;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.toolExecution(event);
        return;
      default:
        return;
    }
  }

  /** 모델이 쓰는 도구 호출: 시작(이름)과 완성된 인자 */
  private toolCall(ae: AssistantMessageEvent, parent?: string): void {
    if (ae.type === "toolcall_start") {
      const block = ae.partial.content[ae.contentIndex] as ToolCall | undefined;
      if (block?.type === "toolCall" && block.id && block.name) this.toolUseStarted(block.id, block.name, parent);
    } else if (ae.type === "toolcall_end") {
      const call = ae.toolCall;
      this.toolUseStarted(call.id, call.name, parent);
      this.send("response.tool_use", { tool_use_id: call.id, name: call.name, input: call.arguments ?? {}, ...tag(parent) });
    }
  }

  /**
   * 도구 실행. parent가 있으면 하위 agent(Agent·SendMessage)가 부른 도구다: 이벤트에 `parent_tool_use_id`를 붙이고,
   * 하위 agent에는 없는 AskUserQuestion·present_file·StructuredOutput 처리는 하지 않는다.
   */
  private toolExecution(
    event: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>,
    parent?: string,
  ): void {
    if (event.parentToolCallId) return;
    switch (event.type) {
      case "tool_execution_start":
        this.running.set(event.toolCallId, { name: event.toolName, startedAt: Date.now(), ...(parent ? { parent } : {}) });
        return;
      case "tool_execution_update": {
        const details = (event.partialResult as { details?: Partial<McpProgressDetails & SubagentEventDetails> } | undefined)?.details;
        const child = details?.subagentEvent;
        if (child && !parent) {
          if (child.type === "message_update") this.toolCall(child.assistantMessageEvent, event.toolCallId);
          else if (child.type === "tool_execution_start" || child.type === "tool_execution_update" || child.type === "tool_execution_end") {
            this.toolExecution(child, event.toolCallId);
          }
          return;
        }
        const progress = details?.mcpProgress;
        if (!progress) return;
        const started = this.running.get(event.toolCallId)?.startedAt ?? Date.now();
        this.send("response.tool_progress", {
          tool_use_id: event.toolCallId,
          name: event.toolName,
          elapsed_seconds: Math.floor((Date.now() - started) / 1000),
          source: "mcp",
          ...(progress.message ? { message: progress.message } : {}),
          progress: progress.progress,
          ...(progress.total !== undefined ? { total: progress.total } : {}),
          ...tag(parent),
        });
        return;
      }
      case "tool_execution_end": {
        this.running.delete(event.toolCallId);
        // 하위 agent가 끝나면 끝을 알리지 못한 하위 도구도 더 이상 실행 중이 아니다.
        for (const [id, t] of this.running) if (t.parent === event.toolCallId) this.running.delete(id);
        if (event.toolName === ASK_USER_TOOL && !parent) {
          // AskUserQuestion의 결과는 내부용 자리표시자라서 클라이언트에 보내지 않는다. 질문은 결과 details에 있다.
          if (!event.isError) this.addPendingQuestion(event.toolCallId, { questions: event.result?.details?.questions ?? [] });
          return;
        }
        this.send("response.tool_result", {
          tool_use_id: event.toolCallId,
          content: toolResultText(event.result),
          is_error: event.isError === true,
          ...tag(parent),
        });
        if (parent) return;
        const details = (event.result as { details?: { file?: PresentedFile; output?: Record<string, unknown> } } | undefined)?.details;
        if (event.toolName === PRESENT_FILE_TOOL && !event.isError && details?.file) this.addFile(details.file);
        if (event.toolName === STRUCTURED_OUTPUT_TOOL && !event.isError && details?.output) this.addStructuredOutput(details.output);
        return;
      }
    }
  }

  /**
   * 한 배치에 AskUserQuestion이 여러 번 오면 질문을 하나의 function_call로 합친다 (call_id는 첫 호출).
   * 답은 합친 질문 전체에 대한 답으로 들어가고, 어느 질문도 답 없이 남지 않는다.
   */
  private addPendingQuestion(callId: string, args: unknown): void {
    const questions = (a: unknown) => {
      const q = (a as { questions?: unknown })?.questions;
      return Array.isArray(q) ? q : [];
    };
    if (!this.pending) {
      this.pending = { call_id: callId, name: ASK_USER_TOOL, arguments: args };
      return;
    }
    const merged = { ...(this.pending.arguments as Record<string, unknown>), questions: [...questions(this.pending.arguments), ...questions(args)] };
    this.pending = { ...this.pending, arguments: merged };
  }

  /** 파일 항목은 완성된 채로 한 번에 보낸다. 그 앞의 텍스트 항목은 닫고, 뒤의 텍스트는 새 항목이 된다. */
  private addFile(file: PresentedFile): void {
    this.closeOpenItems();
    const item: FileItem = { id: newFileId(), type: "file", ...file };
    this.send("response.output_item.added", { output_index: this.outputIndex, item });
    this.send("response.output_item.done", { output_index: this.outputIndex, item });
    this.items.push(item);
    this.outputIndex++;
  }

  /** 구조화된 답은 JSON 텍스트로도 내보낸다: output_text만 읽는 클라이언트도 파싱할 수 있다. */
  private addStructuredOutput(output: Record<string, unknown>): void {
    this.structuredOutput = output;
    this.openMessage();
    const m = this.message!;
    m.text = JSON.stringify(output);
    this.send("response.output_text.delta", { item_id: m.id, output_index: m.outputIndex, content_index: 0, delta: m.text, logprobs: [] });
    this.closeMessage();
  }

  private toolUseStarted(id: string, name: string, parent?: string): void {
    if (this.startedTools.has(id)) return;
    this.startedTools.add(id);
    this.send("response.tool_use_started", { tool_use_id: id, name, ...tag(parent) });
  }

  /** keepalive마다 실행 중인 도구의 경과 시간을 알린다 */
  heartbeat(): void {
    const now = Date.now();
    for (const [id, t] of this.running) {
      this.send("response.tool_progress", {
        tool_use_id: id,
        name: t.name,
        elapsed_seconds: Math.floor((now - t.startedAt) / 1000),
        source: "gateway",
        ...tag(t.parent),
      });
    }
  }

  /** input_tokens에는 캐시 읽기·쓰기가 포함된다 (oh-my-gateway와 같다). */
  usage(): ResponseUsage {
    const { input, output, cacheRead, cacheWrite } = this.usageSum;
    const inputTokens = input + cacheRead + cacheWrite;
    return {
      input_tokens: inputTokens,
      output_tokens: output,
      total_tokens: inputTokens + output,
      input_tokens_details: {
        cached_tokens: cacheRead,
        cache_creation_tokens: cacheWrite,
        ...(this.contextTokens !== null ? { context_tokens: this.contextTokens } : {}),
      },
      ...(this.contextWindow ? { context_window: this.contextWindow } : {}),
    };
  }

  /** 비스트리밍 응답의 output: reasoning 항목들, message 하나 (oh-my-gateway 비스트리밍과 같다), file 항목들 */
  nonStreamOutput(): OutputItem[] {
    const reasoning = this.items.filter((i): i is ReasoningItem => i.type === "reasoning");
    // 구조화된 답이 있으면 그 JSON만 둔다 (앞에 쓴 문장이 섞이면 파싱할 수 없다).
    const text = this.structuredOutput
      ? JSON.stringify(this.structuredOutput)
      : this.items
          .filter((i): i is MessageItem => i.type === "message")
          .map((m) => m.content.map((c) => c.text).join(""))
          .join("");
    const message: MessageItem = {
      id: newMessageId(),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    return [...reasoning, message, ...this.items.filter((i): i is FileItem => i.type === "file")];
  }
}
