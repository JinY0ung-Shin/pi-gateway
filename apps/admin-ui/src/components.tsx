import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, errorText, formatTime, timeAgo } from "./api";

/** 메뉴·로그인 화면 상단의 이름 */
export function Brand() {
  return (
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        π
      </span>
      <span>
        <strong>pi-gateway</strong>
        <span class="brand-sub">관리</span>
      </span>
    </div>
  );
}

export function Badge(props: { tone?: "blue" | "green" | "gray" | "amber" | "red" | "violet"; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge badge-${props.tone ?? "gray"}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function RunsInBadge(props: { value: string }) {
  const tone = props.value === "sandbox" ? "green" : props.value === "broker" ? "violet" : "blue";
  return <Badge tone={tone}>{props.value}</Badge>;
}

export function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <label class={`toggle${props.disabled ? " toggle-disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="toggle-track" aria-hidden="true" />
    </label>
  );
}

export function Notice(props: { tone?: "info" | "error" | "warn" | "ok"; children: ComponentChildren; onClose?: () => void }) {
  return (
    <div class={`notice notice-${props.tone ?? "info"}`} role={props.tone === "error" ? "alert" : "status"}>
      <div>{props.children}</div>
      {props.onClose && (
        <button class="link" onClick={props.onClose} aria-label="닫기">
          ×
        </button>
      )}
    </div>
  );
}

export function Section(props: { title: string; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="section">
      <header class="section-head">
        <h2>{props.title}</h2>
        <div class="row">{props.actions}</div>
      </header>
      {props.children}
    </section>
  );
}

/** 목록의 시각. 하루 안이면 얼마 전인지로 보이고, 올려 두면 정확한 시각이 나온다. */
export function Time(props: { at: string | null | undefined }) {
  return <time title={formatTime(props.at)}>{timeAgo(props.at)}</time>;
}

/** 지금 수치 하나. of는 전체 크기 (heap 사용량 / 전체), note는 값 옆의 작은 글, tone은 눈에 띄어야 할 때의 색. */
export function Stat(props: { label: string; value: ComponentChildren; of?: string; note?: ComponentChildren; tone?: "warn" | "err" }) {
  return (
    <div class="stat">
      <div class="muted small-text">{props.label}</div>
      <div class={`stat-value${props.tone ? ` ${props.tone}-text` : ""}`}>
        {props.value}
        {props.of && <small> / {props.of}</small>}
        {props.note && <small> {props.note}</small>}
      </div>
    </div>
  );
}

/**
 * 표의 막대 칸 (`table.chart` 안에서 쓴다). 길이는 그 열의 가장 큰 값(max)에 대한 value이고, upTo가 있으면 거기까지 가는 선이 이어진다
 * (중앙값 뒤의 p95). 값은 옆 칸에 적는다. kind는 색: LLM 호출, 도구 실행, 둘 다 아닌 것.
 */
export function Bar(props: { kind?: "llm" | "tool" | "other"; value: number; upTo?: number; max: number }) {
  const width = (value: number) => `${props.max > 0 ? (value / props.max) * 100 : 0}%`;
  return (
    <td class="bar-cell" aria-hidden="true">
      <span class={`bar k-${props.kind ?? "other"}`}>
        {props.upTo !== undefined && props.upTo > 0 && <i class="upto" style={{ width: width(props.upTo) }} />}
        {props.value > 0 && <i style={{ width: width(props.value) }} />}
      </span>
    </td>
  );
}

/** 순위 표가 든 구역 (서버가 전부 준 통계). 위 10줄만 보이고 나머지는 전체 보기 창에서 본다. */
export function Ranked<T>(props: { title: string; rows: T[]; table: (rows: T[]) => JSX.Element; children?: ComponentChildren }) {
  const TOP = 10;
  const [all, setAll] = useState(false);
  const more = props.rows.length > TOP && (
    <button class="small" onClick={() => setAll(true)}>
      전체 {props.rows.length}개 보기
    </button>
  );
  return (
    <Section title={props.title} actions={more}>
      {props.children}
      {props.table(props.rows.slice(0, TOP))}
      {all && (
        <Modal title={props.title} wide onClose={() => setAll(false)}>
          {props.table(props.rows)}
        </Modal>
      )}
    </Section>
  );
}

/**
 * 한 페이지씩 받는 목록 (`?page=N` → `{ items, total, pageSize, … }`). 페이지를 넘기는 동안 앞 페이지를 그대로 둔다 (표가 비었다 차지 않게).
 * refresh가 바뀌면 지금 페이지를 다시 읽는다. path가 바뀌는 목록은 key로 다시 만들어 첫 페이지부터 보게 한다.
 */
export function usePaged<P extends { total: number; pageSize: number }>(path: string, refresh?: unknown): { data: P | null; error: string | null; pager: ComponentChildren } {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<P | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<P>("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}`).then(
      (next) => {
        if (!alive) return;
        setData(next);
        setError(null);
      },
      (err) => alive && setError(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, [path, page, refresh]);
  return { data, error, pager: data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> };
}

/** 누르는 표 줄: 마우스로 누르거나, Tab으로 가서 Enter·Space를 누르면 같은 일을 한다 (줄 안의 버튼에서 누른 키는 그 버튼의 것이다). */
export const rowAction = (run: () => void) => ({
  class: "clickable",
  tabIndex: 0,
  onClick: run,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    run();
  },
});

/** 표 아래의 페이지 줄: 지금 보이는 범위와 전체 수, 처음·이전·다음·끝. 한 페이지에 다 들어가면 수만 적는다. */
export function Pager(props: { page: number; pageSize: number; total: number; disabled?: boolean; onPage: (page: number) => void }) {
  const { page, pageSize, total } = props;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const go = (to: number, label: string) => (
    <button class="small" disabled={props.disabled || to === page || to < 1 || to > pages} onClick={() => props.onPage(to)}>
      {label}
    </button>
  );
  return (
    <nav class="row wrap pager" aria-label="페이지">
      <span class="muted small-text grow">
        {pages === 1 ? `${total.toLocaleString()}개` : `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} / 전체 ${total.toLocaleString()}개`}
      </span>
      {pages > 1 && (
        <>
          {go(1, "처음")}
          {go(page - 1, "이전")}
          <span class="small-text pager-at">
            {page} / {pages}
          </span>
          {go(page + 1, "다음")}
          {go(pages, "끝")}
        </>
      )}
    </nav>
  );
}

/** 빈 표의 안내 줄 */
export function EmptyRow(props: { cols: number; children: ComponentChildren }) {
  return (
    <tr>
      <td colSpan={props.cols} class="muted">
        {props.children}
      </td>
    </tr>
  );
}

/** 목록 위에 뜨는 편집·상세 창. ×나 Esc로 닫으면 onClose가 불린다. 머리는 두고 본문만 스크롤한다. wide: 칸이 많은 표를 담는 넓은 창 */
export function Modal(props: { title: ComponentChildren; actions?: ComponentChildren; wide?: boolean; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 그리기 전에 열어야 key가 바뀌어 다시 만들어질 때 깜빡이지 않는다
  useLayoutEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} class={props.wide ? "modal wide" : "modal"} onClose={props.onClose}>
      <header class="section-head">
        <h2>{props.title}</h2>
        <div class="row">
          {props.actions}
          <button class="modal-close" onClick={() => ref.current?.close()} aria-label="닫기" title="닫기 (Esc)">
            ×
          </button>
        </div>
      </header>
      {/* 열면 본문에 초점을 둔다. 머리의 첫 버튼·스위치에 두면 Space로 스크롤하려다 그것이 눌린다. */}
      <div class="modal-body" tabIndex={-1} autofocus>
        {props.children}
      </div>
    </dialog>
  );
}

/**
 * 관리 API GET 결과. path가 바뀌면 비우고 다시 부르고, everyMs를 주면 그 간격으로 다시 부른다 (간격은 도중에 바꿀 수 있다).
 * 실패하면 error에 담고, 이전 data는 그대로 둔다 (새로고침 실패를 경고로만 보일 수 있게).
 */
export function useLoad<T>(path: string, everyMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try {
      setData(await api<T>("GET", path));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    setData(null);
    setError(null);
  }, [path]);
  // 간격만 바뀌면 data는 두고 바로 한 번 다시 부른다
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<T>("GET", path).then(
        (next) => {
          if (!alive) return;
          setData(next);
          setError(null);
        },
        (err) => alive && setError(errorText(err)),
      );
    void load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, everyMs]);
  return { data, error, reload };
}

/** 비동기 작업 상태 (진행 중 표시, 결과·오류 메시지) */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const run = async <T,>(fn: () => Promise<T>, okText?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      if (okText) setMessage({ tone: "ok", text: typeof okText === "function" ? okText(result) : okText });
      return result;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const view = message ? (
    <Notice tone={message.tone} onClose={() => setMessage(null)}>
      {message.text}
    </Notice>
  ) : null;
  return { busy, run, view };
}

/** 페이지 아래의 저장·되돌리기 줄. 저장하지 않은 변경이 있으면 화면 아래에 붙어 있다. */
export function SaveBar(props: { dirty: boolean; action: { busy: boolean; view: ComponentChildren }; onSave: () => void; onRevert: () => void }) {
  const { dirty, action } = props;
  return (
    <div class={dirty ? "save-bar dirty" : "save-bar"}>
      {action.view}
      <div class="row wrap">
        <button class="primary" disabled={action.busy || !dirty} onClick={props.onSave}>
          저장
        </button>
        <button disabled={action.busy || !dirty} onClick={props.onRevert}>
          되돌리기
        </button>
        {dirty ? <span class="warn-text small-text">저장하지 않은 변경이 있습니다.</span> : <span class="muted small-text">바뀐 것이 없습니다.</span>}
      </div>
    </div>
  );
}

/** API 키 칸. 저장된 키는 보여 주지 않고, 비워 두면 그대로 쓴다. */
export function ApiKeyField(props: {
  id: string;
  value: { apiKey: string; apiKeySet: boolean; clearKey: boolean };
  onChange: (patch: { apiKey?: string; clearKey?: boolean }) => void;
}) {
  const v = props.value;
  return (
    <div class="field">
      <label class="field-label" for={props.id}>
        API 키 {v.apiKeySet ? <Badge tone="green">저장됨</Badge> : <Badge>없음</Badge>}
      </label>
      <input
        id={props.id}
        type="password"
        class="mono"
        autocomplete="off"
        value={v.apiKey}
        disabled={v.clearKey}
        placeholder={v.apiKeySet ? "바꿀 때만 입력 (비우면 저장된 키를 씁니다)" : "키가 없는 엔드포인트면 비워 둡니다"}
        onInput={(e) => props.onChange({ apiKey: e.currentTarget.value })}
      />
      {v.apiKeySet && (
        <label class="checkbox">
          <input type="checkbox" checked={v.clearKey} onChange={(e) => props.onChange({ clearKey: e.currentTarget.checked })} />
          <span>저장된 키 지우기</span>
        </label>
      )}
    </div>
  );
}

/** `KEY=VALUE` 줄 ↔ 객체 */
export function recordToLines(record: Record<string, string> | undefined, sep = "="): string {
  return Object.entries(record ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

export function linesToRecord(text: string, sep = "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf(sep);
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + sep.length).trim();
  }
  return out;
}
