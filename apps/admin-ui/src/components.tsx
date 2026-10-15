import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";

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

/** 줄 단위 diff (LCS). 너무 큰 입력은 비교하지 않는다. */
export function LineDiff(props: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const a = props.before.split("\n");
  const b = props.after.split("\n");
  if (a.length * b.length > 4_000_000) return <Notice tone="warn">내용이 너무 커서 비교할 수 없습니다.</Notice>;
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: { kind: "same" | "del" | "add"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) lines.push({ kind: "del", text: a[i++]! });
    else lines.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "add", text: b[j++]! });
  const changed = lines.some((l) => l.kind !== "same");
  return (
    <div class="diff">
      <div class="diff-legend">
        <span class="diff-del">− {props.beforeLabel}</span>
        <span class="diff-add">+ {props.afterLabel}</span>
      </div>
      {!changed && <p class="muted">차이가 없습니다.</p>}
      <pre>
        {lines.map((l, k) => (
          <div key={k} class={`diff-${l.kind}`}>
            {l.kind === "del" ? "− " : l.kind === "add" ? "+ " : "  "}
            {l.text}
          </div>
        ))}
      </pre>
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
