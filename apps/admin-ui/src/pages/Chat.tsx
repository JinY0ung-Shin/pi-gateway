import { useRef, useState } from "preact/hooks";
import { Badge, Notice, Section } from "../components";

/**
 * 채팅 테스트. `/admin/api/chat`(= `/v1/responses`, stream)로 운영과 같은 구성(MCP·skill·plugin)에서 대화한다.
 * 중지하면 연결을 끊는다. 그 턴은 기록되지 않는다.
 */

interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  tools: ToolCall[];
  note?: { tone: "warn" | "error"; text: string };
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

interface Pending {
  callId: string;
  questions: Question[];
}

type ResponseEvent = Record<string, any> & { type: string };

const RESULT_LIMIT = 4000;

async function readSse(res: Response, onEvent: (event: ResponseEvent) => void): Promise<void> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as ResponseEvent);
    }
  }
}

function newTurn(role: Turn["role"], text = ""): Turn {
  return { role, text, reasoning: "", tools: [] };
}

export function ChatPage() {
  const [user, setUser] = useState("admin");
  const [metadata, setMetadata] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [prevId, setPrevId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const turns = useRef<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const rerender = () => setTick((n) => n + 1);

  const reset = () => {
    abort.current?.abort();
    turns.current = [];
    setPending(null);
    setPrevId(null);
    rerender();
  };

  const send = async (input: unknown, shown: string) => {
    let meta: Record<string, string> | undefined;
    if (metadata.trim()) {
      try {
        meta = JSON.parse(metadata) as Record<string, string>;
      } catch {
        turns.current.push({ ...newTurn("assistant"), note: { tone: "error", text: "metadata가 JSON 객체가 아닙니다." } });
        rerender();
        return;
      }
    }
    const reply = newTurn("assistant");
    turns.current.push(newTurn("user", shown), reply);
    setPending(null);
    setBusy(true);
    rerender();
    const controller = new AbortController();
    abort.current = controller;
    const tool = (id: string) => reply.tools.find((t) => t.id === id);
    let gap = false;
    try {
      const res = await fetch("/admin/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-admin-request": "1" },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify({ user, input, stream: true, ...(prevId ? { previous_response_id: prevId } : {}), ...(meta ? { metadata: meta } : {}) }),
      });
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        reply.note = { tone: "error", text: `HTTP ${res.status}: ${body?.error?.message ?? res.statusText}` };
        return;
      }
      await readSse(res, (event) => {
        switch (event.type) {
          case "response.output_text.delta":
            // 도구 호출 앞뒤의 답변은 한 메시지로 온다. 이어 붙이지 않고 줄을 띄운다.
            if (gap) reply.text += "\n\n";
            gap = false;
            reply.text += event.delta;
            break;
          case "response.reasoning_summary_text.delta":
            reply.reasoning += event.delta;
            break;
          case "response.tool_use_started":
            gap = reply.text !== "";
            if (!tool(event.tool_use_id)) reply.tools.push({ id: event.tool_use_id, name: event.name });
            break;
          case "response.tool_use": {
            const t = tool(event.tool_use_id);
            if (t) t.input = event.input;
            break;
          }
          case "response.tool_result": {
            const t = tool(event.tool_use_id);
            if (t) {
              t.result = String(event.content ?? "");
              t.isError = event.is_error === true;
            }
            break;
          }
          case "response.completed": {
            const r = event.response;
            setPrevId(r.id);
            if (r.status === "requires_action") {
              const call = (r.output as { type: string; call_id: string; arguments: string }[]).find((o) => o.type === "function_call");
              if (call) setPending({ callId: call.call_id, questions: (JSON.parse(call.arguments).questions ?? []) as Question[] });
            }
            break;
          }
          case "response.incomplete":
            setPrevId(event.response.id);
            reply.note = { tone: "warn", text: `응답이 끝까지 생성되지 않았습니다 (${event.response.incomplete_details?.reason ?? "incomplete"}).` };
            break;
          case "response.failed":
            reply.note = { tone: "error", text: event.response.error?.message ?? "응답 실패" };
            break;
          default:
            return;
        }
        rerender();
      });
    } catch (error) {
      reply.note = controller.signal.aborted
        ? { tone: "warn", text: "중지했습니다. 이 턴은 기록되지 않습니다." }
        : { tone: "error", text: error instanceof Error ? error.message : String(error) };
    } finally {
      abort.current = null;
      setBusy(false);
      rerender();
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || busy || pending) return;
    setDraft("");
    void send(text, text);
  };

  return (
    <Section
      title="채팅 테스트"
      actions={
        <>
          {prevId && <span class="muted small-text mono">{prevId}</span>}
          <button onClick={reset} disabled={turns.current.length === 0}>
            새 대화
          </button>
        </>
      }
    >
      <div class="grid-2">
        <label class="field">
          <span>user (이 사용자의 workspace·MCP로 실행됩니다)</span>
          <input class="mono" value={user} disabled={prevId !== null} onInput={(e) => setUser(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>metadata (JSON, 선택)</span>
          <input
            class="mono"
            value={metadata}
            placeholder='{"THREAD_ID":"admin-test"}'
            onInput={(e) => setMetadata(e.currentTarget.value)}
          />
        </label>
      </div>

      <div class="chat-log">
        {turns.current.length === 0 && <p class="muted">메시지를 보내면 운영과 같은 도구·MCP·skill 구성으로 대화합니다.</p>}
        {turns.current.map((turn, i) => (
          <div key={i} class={`msg msg-${turn.role}`}>
            {turn.reasoning && (
              <details>
                <summary>생각</summary>
                <div class="code-block">{turn.reasoning}</div>
              </details>
            )}
            {turn.tools.map((t) => (
              <details key={t.id} class="tool">
                <summary>
                  <span class="mono">{t.name}</span>{" "}
                  {t.name === "AskUserQuestion" ? <Badge tone="violet">질문</Badge> : t.result === undefined ? <Badge tone="blue">실행 중</Badge> : t.isError ? <Badge tone="red">오류</Badge> : <Badge tone="green">완료</Badge>}
                </summary>
                {t.input !== undefined && <div class="code-block mono">{JSON.stringify(t.input, null, 2)}</div>}
                {t.result !== undefined && (
                  <div class="code-block mono">{t.result.length > RESULT_LIMIT ? `${t.result.slice(0, RESULT_LIMIT)}\n… (${t.result.length}자)` : t.result}</div>
                )}
              </details>
            ))}
            {turn.text && <div class="msg-text">{turn.text}</div>}
            {turn.role === "assistant" && busy && i === turns.current.length - 1 && !turn.text && <span class="muted">…</span>}
            {turn.note && <Notice tone={turn.note.tone}>{turn.note.text}</Notice>}
          </div>
        ))}
      </div>

      {pending ? (
        <QuestionForm pending={pending} onAnswer={(output) => void send([{ type: "function_call_output", call_id: pending.callId, output }], output)} />
      ) : (
        <div class="row">
          <textarea
            class="grow"
            rows={3}
            value={draft}
            placeholder="메시지 (Enter 보내기, Shift+Enter 줄바꿈)"
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submitDraft();
              }
            }}
          />
          {busy ? (
            <button class="danger" onClick={() => abort.current?.abort()}>
              중지
            </button>
          ) : (
            <button class="primary" onClick={submitDraft} disabled={!draft.trim()}>
              보내기
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/** AskUserQuestion 답하기. 답은 "질문: 선택" 줄들로 보낸다. */
function QuestionForm(props: { pending: Pending; onAnswer: (output: string) => void }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const toggle = (qi: number, label: string, multi: boolean) => {
    const cur = picked[qi] ?? [];
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [qi]: next });
  };
  const answers = props.pending.questions.map((_, qi) => [...(picked[qi] ?? []), other[qi]?.trim() ?? ""].filter(Boolean));
  return (
    <div class="card question">
      {props.pending.questions.map((q, qi) => (
        <div key={qi} class="field">
          <strong>
            {q.header && <Badge tone="violet">{q.header}</Badge>} {q.question}
          </strong>
          {q.options.map((o) => (
            <label key={o.label} class="checkbox">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`q${qi}`}
                checked={(picked[qi] ?? []).includes(o.label)}
                onChange={() => toggle(qi, o.label, q.multiSelect === true)}
              />
              <span>
                {o.label} {o.description && <span class="muted small-text">— {o.description}</span>}
              </span>
            </label>
          ))}
          <input placeholder="직접 입력 (선택)" value={other[qi] ?? ""} onInput={(e) => setOther({ ...other, [qi]: e.currentTarget.value })} />
        </div>
      ))}
      <button
        class="primary"
        disabled={answers.some((a) => a.length === 0)}
        onClick={() => props.onAnswer(props.pending.questions.map((q, qi) => `${q.question}: ${answers[qi]!.join(", ")}`).join("\n"))}
      >
        답하기
      </button>
    </div>
  );
}
