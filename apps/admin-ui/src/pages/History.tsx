import { useEffect, useState } from "preact/hooks";
import { api, enc, formatTime } from "../api";
import { Modal, Notice, Section, useAction, useLoad } from "../components";
import { newTurn, type ToolCall, type Turn, TurnView } from "./Chat";

/** 서버에 저장된 대화 기록 (읽기 전용)과 보관 기간 */

interface SessionSummary {
  id: string;
  user: string;
  model: string;
  turn: number;
  createdAt: string;
  lastActiveAt: string;
}

interface Retention {
  days: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

type Content = string | { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
interface PiMessage {
  role: string;
  content: Content;
  /** system: 이름 붙은 프롬프트 섹션 (뒤의 메시지는 바뀐 섹션만, null = 삭제) */
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string; description?: string; parameters?: unknown }[];
  toolsRemoved?: { name: string }[];
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function textOf(content: Content): string {
  if (typeof content === "string") return content;
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  const images = content.filter((c) => c.type === "image").length;
  return [...text, ...(images ? [`[이미지 ${images}개]`] : [])].join("\n");
}

/** 대화에 끼어 있는 시스템 프롬프트(pi system 메시지). 처음 것이 전체이고, 뒤의 것은 바뀐 부분이다. */
interface SystemItem {
  system: PiMessage;
  first: boolean;
  /** 대화의 첫 LLM 호출 입력 토큰 (시스템 프롬프트 + 도구 선언 + 첫 메시지) */
  firstInput?: number;
}

/**
 * pi 메시지 → 채팅 화면의 턴 (사용자 메시지 하나와 그에 대한 답 하나씩)과 시스템 프롬프트.
 * 답의 토큰은 채팅 화면과 같게 센다: 입력은 그 턴 마지막 LLM 호출의 대화 크기, 출력은 호출들의 합.
 */
function toTurns(messages: PiMessage[]): (Turn | SystemItem)[] {
  const turns: (Turn | SystemItem)[] = [];
  const tools = new Map<string, ToolCall>();
  let reply: Turn | null = null;
  let firstSystem: SystemItem | null = null;
  let firstCallSeen = false;
  for (const m of messages) {
    if (m.role === "system") {
      const item: SystemItem = { system: m, first: !firstSystem };
      firstSystem ??= item;
      turns.push(item);
      reply = null;
    } else if (m.role === "user") {
      turns.push(newTurn("user", textOf(m.content)));
      reply = null;
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      if (!reply) turns.push((reply = newTurn("assistant")));
      for (const c of m.content) {
        if (c.type === "text" && c.text) reply.text += (reply.text ? "\n\n" : "") + c.text;
        else if (c.type === "thinking" && c.thinking) reply.reasoning += c.thinking;
        else if (c.type === "toolCall" && c.id) {
          const t: ToolCall = { id: c.id, name: c.name ?? "", input: c.arguments };
          reply.tools.push(t);
          tools.set(c.id, t);
        }
      }
      if (m.usage) {
        const input = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
        if (!firstCallSeen && firstSystem && input > 0) firstSystem.firstInput = input;
        firstCallSeen = true;
        reply.usage = { input: input || (reply.usage?.input ?? 0), output: (reply.usage?.output ?? 0) + m.usage.output };
      }
      if (m.stopReason === "error") reply.note = { tone: "error", text: m.errorMessage ?? "응답 실패" };
      else if (m.stopReason === "aborted") reply.note = { tone: "warn", text: "중지된 응답입니다." };
    } else if (m.role === "toolResult" && m.toolCallId) {
      const t = tools.get(m.toolCallId);
      if (t) {
        t.result = textOf(m.content);
        t.isError = m.isError === true;
      }
    }
  }
  return turns;
}

export function HistoryPage(props: { focus?: string }) {
  return (
    <>
      <RetentionSection />
      <SessionList />
      {props.focus && <Transcript id={props.focus} />}
    </>
  );
}

function RetentionSection() {
  const [retention, setRetention] = useState<Retention | null>(null);
  const [days, setDays] = useState("");
  const action = useAction();

  const show = (r: Retention) => {
    setRetention(r);
    setDays(String(r.days));
  };
  useEffect(() => {
    void action.run(async () => show(await api<Retention>("GET", "/history/retention")));
  }, []);

  const save = () =>
    action.run(async () => show(await api<Retention>("PUT", "/history/retention", { days: Number(days) })), "저장했습니다.");

  return (
    <Section title="보관 기간">
      {action.view}
      <div class="row">
        <input class="days" type="number" min={0} max={3650} value={days} aria-label="보관 기간(일)" onInput={(e) => setDays(e.currentTarget.value)} />
        <span>일 보관</span>
        <button class="primary" disabled={action.busy || !retention || !days.trim() || days === String(retention.days)} onClick={() => void save()}>
          저장
        </button>
        {retention && <span class="muted small-text">현재: {retention.days === 0 ? "지우지 않음" : `${retention.days}일`}</span>}
      </div>
      <p class="muted small-text">
        마지막 활동 뒤 이 기간이 지난 세션은 기록이 지워져 더 이상 이어갈 수 없습니다. 0이면 지우지 않습니다. workspace 파일은 남습니다.
        {retention?.updatedAt && ` (마지막 변경 ${formatTime(retention.updatedAt)}, ${retention.updatedBy})`}
      </p>
    </Section>
  );
}

function SessionList() {
  const [user, setUser] = useState("");
  const [list, setList] = useState<{ items: SessionSummary[]; limit: number } | null>(null);
  const action = useAction();

  const load = () =>
    action.run(async () => setList(await api<{ items: SessionSummary[]; limit: number }>("GET", `/history${user.trim() ? `?user=${enc(user.trim())}` : ""}`)));
  useEffect(() => {
    void load();
  }, []);

  return (
    <Section title="세션" actions={list && <span class="muted small-text">최근 활동 순, 최대 {list.limit}개</span>}>
      {action.view}
      <div class="row">
        <input
          class="mono grow"
          value={user}
          placeholder="user (비우면 전체)"
          onInput={(e) => setUser(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
        />
        <button disabled={action.busy} onClick={() => void load()}>
          조회
        </button>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>마지막 활동</th>
            <th>user</th>
            <th>모델</th>
            <th>턴</th>
            <th>세션</th>
          </tr>
        </thead>
        <tbody>
          {list?.items.length === 0 && (
            <tr>
              <td colSpan={5} class="muted">
                저장된 세션이 없습니다.
              </td>
            </tr>
          )}
          {list?.items.map((s) => (
            <tr key={s.id} class="clickable" onClick={() => (location.hash = `#/history/${enc(s.id)}`)}>
              <td>{formatTime(s.lastActiveAt)}</td>
              <td class="mono">{s.user}</td>
              <td class="mono small-text">{s.model}</td>
              <td>{s.turn}</td>
              <td class="mono small-text">{s.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Transcript(props: { id: string }) {
  const { data, error } = useLoad<SessionSummary & { messages: PiMessage[] }>(`/history/${enc(props.id)}`);
  const turns = data ? toTurns(data.messages) : [];

  return (
    <Modal title="대화" onClose={() => (location.hash = "#/history")}>
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && <p class="muted">불러오는 중…</p>}
      {data && (
        <>
          <p class="muted small-text">
            <span class="mono">{data.user}</span> · <span class="mono">{data.model}</span> · {formatTime(data.createdAt)} 시작 · 마지막 활동{" "}
            {formatTime(data.lastActiveAt)} · <span class="mono">{data.id}</span>
          </p>
          <div class="chat-log">
            {turns.length === 0 && <p class="muted">기록된 메시지가 없습니다.</p>}
            {turns.map((turn, i) => ("system" in turn ? <SystemView key={i} {...turn} /> : <TurnView key={i} turn={turn} />))}
          </div>
        </>
      )}
    </Modal>
  );
}

/** 모델이 받은 시스템 프롬프트와 도구 선언 (pi가 요청에 실은 그대로) */
function SystemView(props: SystemItem) {
  const { system, first } = props;
  const sections = Object.entries(system.sections ?? {});
  const base = textOf(system.content);
  const text = first
    ? [base, ...sections.map(([, v]) => v ?? "")].filter(Boolean).join("\n\n")
    : [base, ...sections.map(([name, v]) => (v === null ? `[섹션 ${name} 삭제]` : `[섹션 ${name} 변경]\n\n${v}`))].filter(Boolean).join("\n\n");
  const added = system.toolsAdded ?? [];
  const removed = system.toolsRemoved ?? [];
  return (
    <details class="tool">
      <summary>
        {first ? "시스템 프롬프트" : "시스템 프롬프트 변경"}
        {props.firstInput !== undefined && ` · 첫 요청 입력 ${props.firstInput.toLocaleString()} 토큰`}
        {added.length > 0 && ` · 도구 +${added.length}`}
        {removed.length > 0 && ` · 도구 −${removed.length}`}
      </summary>
      {text && <div class="code-block">{text}</div>}
      {added.length > 0 && (
        <details>
          <summary>추가된 도구: {added.map((t) => t.name).join(", ")}</summary>
          <div class="code-block mono">{JSON.stringify(added, null, 2)}</div>
        </details>
      )}
      {removed.length > 0 && <p class="muted small-text">제거된 도구: {removed.map((t) => t.name).join(", ")}</p>}
    </details>
  );
}
