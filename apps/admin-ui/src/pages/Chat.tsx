import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, enc } from "../api";
import { Badge, Notice, Section, useLoad } from "../components";

/**
 * 채팅 테스트. `/admin/api/chat`(= `/v1/responses`, stream)로 운영과 같은 구성(MCP·skill·plugin)에서 대화한다.
 * 중지는 `/admin/api/chat/{id}/cancel`(= `/v1/responses/{id}/cancel`)이라 멈춘 턴도 기록에 남는다.
 * 대화는 이 브라우저에만 저장한다 (새로고침 후 이어가기용).
 */

interface ChatOptions {
  models: { id: string; name: string; reasoning: boolean; efforts: string[]; defaultEffort: string; image: boolean }[];
  /** LLM이 설정되지 않았으면 null */
  defaultModel: string | null;
  forwardHeaders: string[];
  metadataKeys: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  progress?: string;
}

interface Usage {
  input: number;
  output: number;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  reasoning: string;
  tools: ToolCall[];
  usage?: Usage;
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

/** 세션을 만들 때 정해지고 이어가는 동안 바꿀 수 없는 값 */
interface SessionSettings {
  user: string;
  model: string;
  effort: string;
  instructions: string;
}

interface Saved {
  settings: SessionSettings;
  metadata: string;
  headers: Record<string, string>;
  prevId: string | null;
  pending: Pending | null;
  turns: Turn[];
}

type ResponseEvent = Record<string, any> & { type: string };

const STORAGE_KEY = "pi-gateway-admin-chat";
const RESULT_LIMIT = 4000;

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(state: Saved): void {
  try {
    // 이미지는 저장하지 않는다 (localStorage 용량)
    const turns = state.turns.map(({ images, ...t }) => (images?.length ? { ...t, text: `${t.text}\n[이미지 ${images.length}개]` } : t));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, turns }));
  } catch {
    // 저장하지 못해도 대화는 계속된다
  }
}

/** 답변 Markdown. 이미지는 막는다: 열기만 해도 바깥 주소로 요청이 나가서, 프롬프트 주입이 대화 내용을 빼낼 수 있다. */
function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), { FORBID_TAGS: ["img"] });
}

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

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 입력은 마지막 LLM 호출의 대화 크기(context_tokens)다. input_tokens는 도구를 쓸 때마다 대화 전체를 다시 센 턴 합계라서 쓰지 않는다. */
function usageOf(u: any): Usage | undefined {
  if (!u || (!u.input_tokens && !u.output_tokens)) return undefined;
  return { input: u.input_tokens_details?.context_tokens ?? 0, output: u.output_tokens ?? 0 };
}

export function newTurn(role: Turn["role"], text = "", images?: string[]): Turn {
  return { role, text, reasoning: "", tools: [], ...(images?.length ? { images } : {}) };
}

export function ChatPage() {
  const saved = useRef(load()).current;
  const { data: options, error: optionsError } = useLoad<ChatOptions>("/chat/options");
  const [settings, setSettings] = useState<SessionSettings>(saved?.settings ?? { user: "admin", model: "", effort: "", instructions: "" });
  const [metadata, setMetadata] = useState(saved?.metadata ?? "");
  const [headers, setHeaders] = useState<Record<string, string>>(saved?.headers ?? {});
  const [prevId, setPrevId] = useState<string | null>(saved?.prevId ?? null);
  const [pending, setPending] = useState<Pending | null>(saved?.pending ?? null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const turns = useRef<Turn[]>(saved?.turns ?? []);
  const abort = useRef<AbortController | null>(null);
  const activeId = useRef<string | null>(null);
  const rerender = () => setTick((n) => n + 1);

  useEffect(() => {
    if (options) setSettings((s) => (options.models.some((m) => m.id === s.model) ? s : { ...s, model: options.defaultModel ?? "" }));
  }, [options]);

  useEffect(() => {
    if (!busy) save({ settings, metadata, headers, prevId, pending, turns: turns.current });
  });

  const model = options?.models.find((m) => m.id === settings.model);
  const locked = prevId !== null;
  const set = (patch: Partial<SessionSettings>) => setSettings({ ...settings, ...patch });

  const reset = () => {
    abort.current?.abort();
    turns.current = [];
    setPending(null);
    setPrevId(null);
    setImages([]);
    rerender();
  };

  const stop = async () => {
    const id = activeId.current;
    if (id) {
      try {
        await api("POST", `/chat/${enc(id)}/cancel?user=${enc(settings.user)}`);
        return; // 스트림이 response.incomplete(user_cancelled)로 끝난다
      } catch {
        // 아직 시작 전이거나 이미 끝났다. 연결을 끊는다.
      }
    }
    abort.current?.abort();
  };

  const send = async (input: unknown, shown: string, shownImages?: string[]) => {
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
    const body: Record<string, unknown> = { user: settings.user, model: settings.model || undefined, input, stream: true };
    if (prevId) body.previous_response_id = prevId;
    else {
      if (settings.instructions.trim()) body.instructions = settings.instructions;
      if (settings.effort && model?.reasoning && model.efforts.includes(settings.effort)) body.reasoning = { effort: settings.effort };
    }
    if (meta) body.metadata = meta;
    const forwarded = Object.fromEntries(Object.entries(headers).filter(([name, v]) => v && options?.forwardHeaders.includes(name)));

    const reply = newTurn("assistant");
    turns.current.push(newTurn("user", shown, shownImages), reply);
    setPending(null);
    setBusy(true);
    rerender();
    const controller = new AbortController();
    abort.current = controller;
    activeId.current = null;
    const tool = (id: string) => reply.tools.find((t) => t.id === id);
    let gap = false;
    try {
      const res = await fetch("/admin/api/chat", {
        method: "POST",
        headers: { ...forwarded, "content-type": "application/json", accept: "text/event-stream", "x-admin-request": "1" },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        reply.note = { tone: "error", text: `HTTP ${res.status}: ${err?.error?.message ?? res.statusText}` };
        return;
      }
      await readSse(res, (event) => {
        switch (event.type) {
          case "response.created":
            activeId.current = event.response.id;
            return;
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
          case "response.tool_progress": {
            const t = tool(event.tool_use_id);
            if (!t) return;
            const parts = [`${event.elapsed_seconds}초`];
            if (event.progress !== undefined) parts.push(event.total !== undefined ? `${event.progress}/${event.total}` : String(event.progress));
            if (event.message) parts.push(event.message);
            t.progress = parts.join(" · ");
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
          case "response.completed":
          case "response.incomplete": {
            const r = event.response;
            setPrevId(r.id);
            const usage = usageOf(r.usage);
            if (usage) reply.usage = usage;
            if (event.type === "response.incomplete") {
              const reason = r.incomplete_details?.reason ?? "incomplete";
              reply.note =
                reason === "user_cancelled"
                  ? { tone: "warn", text: "중지했습니다. 여기까지의 내용은 기록에 남고 이어서 대화할 수 있습니다." }
                  : { tone: "warn", text: `응답이 끝까지 생성되지 않았습니다 (${reason}).` };
            } else if (r.status === "requires_action") {
              const call = (r.output as { type: string; call_id: string; arguments: string }[]).find((o) => o.type === "function_call");
              if (call) setPending({ callId: call.call_id, questions: (JSON.parse(call.arguments).questions ?? []) as Question[] });
            }
            break;
          }
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
        ? { tone: "warn", text: "연결을 끊었습니다. 이 턴은 기록되지 않습니다." }
        : { tone: "error", text: error instanceof Error ? error.message : String(error) };
    } finally {
      abort.current = null;
      activeId.current = null;
      setBusy(false);
      rerender();
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || busy || pending) return;
    const input =
      images.length === 0
        ? text
        : [
            {
              role: "user",
              content: [...(text ? [{ type: "input_text", text }] : []), ...images.map((url) => ({ type: "input_image", image_url: url }))],
            },
          ];
    void send(input, text, images);
    setDraft("");
    setImages([]);
  };

  const attach = async (files: FileList | null) => {
    if (!files) return;
    const urls = await Promise.all(Array.from(files).map(readDataUrl));
    setImages([...images, ...urls]);
  };

  return (
    <Section
      title="대화"
      actions={
        <>
          {prevId && <span class="muted small-text mono">{prevId}</span>}
          <button onClick={reset} disabled={busy || turns.current.length === 0}>
            새 대화
          </button>
        </>
      }
    >
      {optionsError && <Notice tone="error">설정을 불러오지 못했습니다: {optionsError}</Notice>}
      {options && !options.defaultModel && (
        <Notice tone="warn">
          LLM이 설정되지 않았습니다. <a href="#/llm">LLM</a> 페이지에서 먼저 설정하세요.
        </Notice>
      )}
      <div class="grid-2">
        <label class="field">
          <span>user (이 사용자의 workspace·MCP로 실행됩니다)</span>
          <input class="mono" value={settings.user} disabled={locked} onInput={(e) => set({ user: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>모델</span>
          <select value={settings.model} disabled={locked || !options} onChange={(e) => set({ model: e.currentTarget.value })}>
            {options?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.image ? " · 이미지" : ""}
                {m.reasoning ? " · reasoning" : ""}
              </option>
            ))}
          </select>
        </label>
        {model?.reasoning && (
          <label class="field">
            <span>reasoning.effort</span>
            <select value={settings.effort} disabled={locked} onChange={(e) => set({ effort: e.currentTarget.value })}>
              <option value="">{`기본 (${model.defaultEffort})`}</option>
              {model.efforts.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        <label class="field">
          <span>metadata (JSON{options?.metadataKeys.length ? `, MCP로 넘어가는 키: ${options.metadataKeys.join(", ")}` : ""})</span>
          <input
            class="mono"
            value={metadata}
            placeholder={`{"${options?.metadataKeys[0] ?? "THREAD_ID"}":"admin-test"}`}
            onInput={(e) => setMetadata(e.currentTarget.value)}
          />
        </label>
        {options?.forwardHeaders.map((name) => (
          <label key={name} class="field">
            <span>헤더 {name} (MCP로 전달)</span>
            <input class="mono" value={headers[name] ?? ""} onInput={(e) => setHeaders({ ...headers, [name]: e.currentTarget.value })} />
          </label>
        ))}
      </div>
      {!locked && (
        <details>
          <summary>instructions (첫 턴에만, 시스템 프롬프트 뒤에 붙습니다)</summary>
          <textarea rows={3} value={settings.instructions} onInput={(e) => set({ instructions: e.currentTarget.value })} />
        </details>
      )}

      <div class="chat-log">
        {turns.current.length === 0 && <p class="muted">메시지를 보내면 운영과 같은 도구·MCP·skill 구성으로 대화합니다.</p>}
        {turns.current.map((turn, i) => (
          <TurnView key={i} turn={turn} waiting={busy && i === turns.current.length - 1} />
        ))}
      </div>

      {pending && !busy ? (
        <QuestionForm pending={pending} onAnswer={(output) => void send([{ type: "function_call_output", call_id: pending.callId, output }], output)} />
      ) : (
        <>
          {images.length > 0 && (
            <div class="row wrap">
              {images.map((src, k) => (
                <button key={k} class="thumb-button" title="빼기" onClick={() => setImages(images.filter((_, j) => j !== k))}>
                  <img class="thumb" src={src} alt="" />
                </button>
              ))}
            </div>
          )}
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
            {model?.image && (
              <label class="button-like" title="이미지 첨부">
                이미지
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    void attach(e.currentTarget.files);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            )}
            {busy ? (
              <button class="danger" onClick={() => void stop()}>
                중지
              </button>
            ) : (
              <button class="primary" onClick={submitDraft} disabled={!draft.trim() && images.length === 0}>
                보내기
              </button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

/** 메시지 하나 (채팅 테스트와 대화 기록이 같이 쓴다). waiting이면 답을 기다리는 중이다. */
export function TurnView(props: { turn: Turn; waiting?: boolean }) {
  const { turn } = props;
  // 도구 호출은 한 줄로 접어 둔다 (쌓이면 메시지가 길어진다). 요약에는 실행 중인 도구와 오류 수만 보인다.
  const running = props.waiting ? turn.tools.filter((t) => t.result === undefined && t.name !== "AskUserQuestion").at(-1) : undefined;
  const errors = turn.tools.filter((t) => t.isError).length;
  return (
    <div class={`msg msg-${turn.role}`}>
      {turn.reasoning && (
        <details>
          <summary>생각</summary>
          <div class="code-block">{turn.reasoning}</div>
        </details>
      )}
      {turn.tools.length > 0 && (
        <details class="tool">
          <summary>
            도구 호출 {turn.tools.length}개{" "}
            {running && <Badge tone="blue">{`실행 중 · ${running.name}${running.progress ? ` · ${running.progress}` : ""}`}</Badge>}{" "}
            {errors > 0 && <Badge tone="red">오류 {errors}</Badge>}
          </summary>
          <div class="tool-group">
            {turn.tools.map((t) => (
              <details key={t.id} class="tool">
                <summary>
                  <span class="mono">{t.name}</span>{" "}
                  {t.name === "AskUserQuestion" ? (
                    <Badge tone="violet">질문</Badge>
                  ) : t.result === undefined ? (
                    <Badge tone="blue">{t.progress ? `실행 중 · ${t.progress}` : "실행 중"}</Badge>
                  ) : t.isError ? (
                    <Badge tone="red">오류</Badge>
                  ) : (
                    <Badge tone="green">완료</Badge>
                  )}
                </summary>
                {t.input !== undefined && <div class="code-block mono">{JSON.stringify(t.input, null, 2)}</div>}
                {t.result !== undefined && (
                  <div class="code-block mono">{t.result.length > RESULT_LIMIT ? `${t.result.slice(0, RESULT_LIMIT)}\n… (${t.result.length}자)` : t.result}</div>
                )}
              </details>
            ))}
          </div>
        </details>
      )}
      {turn.images && (
        <div class="row wrap">
          {turn.images.map((src, k) => (
            <img key={k} class="thumb" src={src} alt="" />
          ))}
        </div>
      )}
      {turn.text &&
        (turn.role === "assistant" ? <div class="md" dangerouslySetInnerHTML={{ __html: markdown(turn.text) }} /> : <div class="msg-text">{turn.text}</div>)}
      {turn.role === "assistant" && props.waiting && !turn.text && <span class="muted">…</span>}
      {turn.usage && (
        <div class="muted small-text">
          토큰: 입력 {turn.usage.input.toLocaleString()} · 출력 {turn.usage.output.toLocaleString()}
        </div>
      )}
      {turn.note && <Notice tone={turn.note.tone}>{turn.note.text}</Notice>}
    </div>
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
