import { basename, dirname } from "node:path";
import { MCP_CALL_TOOL } from "../mcp-client/proxy.js";
import type { PathEntry } from "../sessions/transcript.js";
import { ASK_USER_TOOL } from "../tools/ask-user.js";
import { STRUCTURED_OUTPUT_TOOL } from "../tools/structured-output.js";
import { mask } from "./mask.js";

/**
 * 세션 기록을 LLM이 읽을 만큼으로 줄인다 (고정 규칙).
 * 남기는 것: 사용자 메시지와 성공한 도구 호출의 이름·인자 앞부분. 버리는 것: 도구 결과, assistant의 글, 실패한 호출.
 */

const USER_CHARS = 500;
const ARGS_CHARS = 300;
/** 같은 도구를 인자를 바꿔 가며 연달아 부른 경우 남기는 줄 수 */
const RUN_KEEP = 5;
/** LLM 호출 하나에 넣는 글자 수 */
const CHUNK_CHARS = 12_000;

/** 사용자 메시지 하나와 그 뒤에 이어진 도구 호출 */
export interface Segment {
  user: string;
  tools: string[];
  startedAt: string;
  endedAt: string;
  /** 이 구간의 마지막 엔트리 (여기까지 분석했다는 커서가 된다) */
  lastEntryId: string;
}

interface Call {
  name: string;
  args: string;
}

interface ToolResult {
  isError: boolean;
  details?: unknown;
}

export function compress(entries: PathEntry[]): Segment[] {
  const results = new Map<string, ToolResult>();
  for (const e of entries) {
    if (e.type === "message" && e.message.role === "toolResult") results.set(e.message.toolCallId, e.message);
  }
  const segments: (Segment & { calls: Call[] })[] = [];
  for (const e of entries) {
    if (e.type === "message" && e.message.role === "user") {
      segments.push({ user: userText(e.message.content), tools: [], calls: [], startedAt: e.timestamp, endedAt: e.timestamp, lastEntryId: e.id });
      continue;
    }
    const segment = segments.at(-1);
    if (!segment) continue;
    if (e.type === "message" && e.message.role === "assistant") {
      for (const c of e.message.content) {
        const call = c.type === "toolCall" ? toCall(c.name, c.arguments, results.get(c.id)) : undefined;
        if (call) segment.calls.push(call);
      }
    }
    segment.endedAt = e.timestamp;
    segment.lastEntryId = e.id;
  }
  return segments.map(({ calls, ...segment }) => ({ ...segment, tools: fold(calls) }));
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function userText(content: string | { type: string; text?: string }[]): string {
  const text = typeof content === "string" ? content : content.map((c) => c.text ?? "").join(" ");
  // `/skill:이름`으로 부르면 pi가 skill 본문 전체를 메시지 앞에 붙인다. 이름만 남긴다.
  const withoutSkill = text.replace(/^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/, "skill/$1");
  return mask(oneLine(withoutSkill)).slice(0, USER_CHARS);
}

function toCall(tool: string, input: Record<string, unknown>, result: ToolResult | undefined): Call | undefined {
  // 결과가 없거나(끝나지 않은 호출) 실패한 호출, 답을 내는 데 쓰는 도구는 작업 단계가 아니다.
  if (!result || result.isError || tool === ASK_USER_TOOL || tool === STRUCTURED_OUTPUT_TOOL) return undefined;
  let name = tool;
  let args: unknown = input;
  if (tool === MCP_CALL_TOOL) {
    const details = result.details as { server?: unknown; tool?: unknown } | undefined;
    name = typeof details?.server === "string" && typeof details.tool === "string" ? `${details.server}/${details.tool}` : String(input.name ?? tool);
    args = input.arguments ?? {};
  } else if (tool === "read" && typeof input.path === "string" && basename(input.path) === "SKILL.md") {
    return { name: `skill/${basename(dirname(input.path))}`, args: "" };
  }
  return { name, args: mask(JSON.stringify(args)).slice(0, ARGS_CHARS) };
}

const line = (call: Call) => (call.args ? `${call.name}(${call.args})` : call.name);

/** 같은 도구를 연달아 부른 것을 줄인다: 인자가 같으면 `×N`, 다르면 고르게 RUN_KEEP개만. */
function fold(calls: Call[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < calls.length; ) {
    let j = i + 1;
    while (j < calls.length && calls[j]!.name === calls[i]!.name) j++;
    const run = calls.slice(i, j);
    if (run.every((c) => c.args === run[0]!.args)) {
      lines.push(run.length > 1 ? `${line(run[0]!)} ×${run.length}` : line(run[0]!));
    } else if (run.length <= RUN_KEEP) {
      lines.push(...run.map(line));
    } else {
      for (let k = 0; k < RUN_KEEP; k++) lines.push(line(run[Math.round((k * (run.length - 1)) / (RUN_KEEP - 1))]!));
      lines.push(`${run[0]!.name} … 외 ${run.length - RUN_KEEP}건`);
    }
    i = j;
  }
  return lines;
}

const size = (s: Segment) => s.user.length + s.tools.reduce((n, t) => n + t.length + 3, 8);

/** 구간 하나가 한도를 넘으면 도구 줄의 가운데를 버린다. */
function fit(segment: Segment): Segment {
  if (size(segment) <= CHUNK_CHARS) return segment;
  const tools = [...segment.tools];
  let dropped = 0;
  while (tools.length > 2 && size({ ...segment, tools }) > CHUNK_CHARS) {
    tools.splice(Math.floor(tools.length / 2), 1);
    dropped++;
  }
  tools.splice(Math.ceil(tools.length / 2), 0, `… 외 ${dropped}건`);
  return { ...segment, tools };
}

/** LLM 호출 하나에 들어갈 만큼씩 나눈다 (사용자 메시지 경계에서만 자른다). */
export function chunks(segments: Segment[]): Segment[][] {
  const out: Segment[][] = [];
  let used = 0;
  for (const segment of segments.map(fit)) {
    if (out.length === 0 || used + size(segment) > CHUNK_CHARS) {
      out.push([]);
      used = 0;
    }
    out.at(-1)!.push(segment);
    used += size(segment);
  }
  return out;
}

/** LLM에 보여 주는 모양. 사용자 메시지 번호는 이 묶음 안에서 1부터다. */
export function render(chunk: Segment[]): string {
  return chunk.map((s, i) => [`[U${i + 1}] ${s.user}`, ...s.tools.map((t) => `  ${t}`)].join("\n")).join("\n");
}
