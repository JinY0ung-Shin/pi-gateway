import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, errorText } from "./api";

/** 메뉴·로그인 화면 상단의 이름 */
export function Brand() {
  return (
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        π
      </span>
      <span>
        <strong class="mono">pi-gateway</strong>
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

export function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; title?: string; label?: string }) {
  return (
    <label class={`toggle${props.disabled ? " toggle-disabled" : ""}`} title={props.title}>
      <input
        type="checkbox"
        role="switch"
        aria-label={props.label ?? props.title}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)}
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

/** 목록 위에 뜨는 편집·상세 창. ×나 Esc로 닫으면 onClose가 불린다. 머리는 두고 본문만 스크롤한다. */
export function Modal(props: { title: ComponentChildren; actions?: ComponentChildren; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 그리기 전에 열어야 key가 바뀌어 다시 만들어질 때 깜빡이지 않는다
  useLayoutEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} class="modal" onClose={props.onClose}>
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
 * 관리 API GET 결과. path가 바뀌면 비우고 다시 부르고, everyMs를 주면 그 간격으로 다시 부른다.
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
    setData(null);
    setError(null);
    void load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path]);
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
  return { busy, run, view, setMessage };
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
