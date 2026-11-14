import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { duration, enc, formatTime, percent } from "../api";
import { Badge, Notice, Section, useLoad } from "../components";
import { Ranked, Stat } from "./Status";

/** 최근 턴들의 trace로 낸 시간 통계 (gateway의 admin/traces.ts traceStats) */

interface Percentiles {
  p50: number;
  p95: number;
}

interface TraceStats {
  turns: number;
  limit: number;
  since?: string;
  failed: number;
  turnMs: Percentiles;
  firstTokenMs: Percentiles;
  share: { llmMs: number; toolMs: number; otherMs: number };
  timeline: Timeline;
  models: { model: string; calls: number; errors: number; firstTokenMs: Percentiles; tokensPerSecond: number }[];
  steps: Step[];
  slowest: { sessionId: string; turn?: number; startedAt: string; durationMs: number; error: boolean }[];
}

interface Timeline {
  stepMs: number;
  buckets: { start: string; turns: number; turnMs: Percentiles }[];
}

interface Step {
  service: string;
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  ms: Percentiles;
}

/** 막대의 색: LLM 호출, 도구 실행, 둘 다 아닌 것 */
type Kind = "llm" | "tool" | "other";
/** 추이의 선 둘까지 더한, 범례에 나오는 색 */
type Mark = Kind | "p50" | "p95";
/** 추이의 세로축 맨 위에 올 수 있는 값 */
const AXIS_TOPS = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000];
const kindOf = (step: string): Kind => (step.startsWith("chat ") ? "llm" : step.startsWith("execute_tool ") ? "tool" : "other");
const maxOf = (values: number[]) => Math.max(...values, 0);

export function TimingPage() {
  const { data, error } = useLoad<TraceStats>("/traces/stats");

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p class="muted">불러오는 중…</p>;
  if (data.turns === 0) return <p class="muted">남아 있는 기록이 없습니다. 실행 시간 기록은 7일 동안 보관합니다.</p>;

  const parts: { kind: Kind; label: string; ms: number }[] = [
    { kind: "llm", label: "LLM 호출", ms: data.share.llmMs },
    { kind: "tool", label: "도구 실행", ms: data.share.toolMs },
    { kind: "other", label: "그 외 (세션 준비, 요약 등)", ms: data.share.otherMs },
  ];
  const total = parts.reduce((sum, p) => sum + p.ms, 0);
  const firstTokenMax = maxOf(data.models.map((m) => m.firstTokenMs.p95));
  const speedMax = maxOf(data.models.map((m) => m.tokensPerSecond));
  const slowestMax = maxOf(data.slowest.map((t) => t.durationMs));
  return (
    <>
      <p class="muted small-text">
        {formatTime(data.since)}부터의 턴 {data.turns.toLocaleString()}개로 냈습니다
        {data.turns >= data.limit ? ` (최근 ${data.limit}개까지만 셉니다)` : " (기록은 7일 동안 보관합니다)"}. p95는 100번 중 95번이 이 시간 안에 끝났다는 뜻이고, 막대(중앙값) 뒤로 이어지는 가는 선이 p95입니다.
      </p>
      <div class="stats">
        <Stat label="턴" value={data.turns.toLocaleString()} />
        <Stat label="턴 시간 (중앙값)" value={duration(data.turnMs.p50)} />
        <Stat label="턴 시간 (p95)" value={duration(data.turnMs.p95)} />
        <Stat label="첫 token까지 (중앙값)" value={duration(data.firstTokenMs.p50)} />
        <Stat label="첫 token까지 (p95)" value={duration(data.firstTokenMs.p95)} />
        <Stat label="실패한 턴" value={percent(data.failed, data.turns)} />
      </div>
      <Section title="턴 시간 추이">
        <Trend timeline={data.timeline} />
      </Section>
      <Section title="시간이 쓰인 곳">
        <div class="split">
          {parts.map(
            (p) =>
              p.ms > 0 && (
                <span key={p.kind} class={`k-${p.kind}`} style={{ flexGrow: p.ms }} title={`${p.label} · ${duration(p.ms)} · ${percent(p.ms, total)}`}>
                  <b>{Math.round((p.ms / total) * 100)}%</b>
                </span>
              ),
          )}
        </div>
        <Legend items={parts.map((p) => ({ kind: p.kind, label: p.label, value: `${duration(p.ms)} · ${percent(p.ms, total)}` }))} />
      </Section>
      <Section title="모델별 응답 속도">
        <p class="muted small-text">출력 속도는 출력 token 합을 호출 시간 합으로 나눈 값입니다 (첫 token을 기다린 시간도 들어 있습니다).</p>
        <table class="table chart">
          <thead>
            <tr>
              <th>모델</th>
              <th colSpan={2}>첫 token (중앙값 · p95)</th>
              <th colSpan={2}>출력 속도 (token/초)</th>
              <th class="num">호출</th>
              <th class="num">오류율</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.model}>
                <td class="clip mono" title={m.model}>
                  {m.model}
                </td>
                <Bar kind="llm" value={m.firstTokenMs.p50} upTo={m.firstTokenMs.p95} max={firstTokenMax} />
                <td class="num">
                  {duration(m.firstTokenMs.p50)} · {duration(m.firstTokenMs.p95)}
                </td>
                <Bar kind="llm" value={m.tokensPerSecond} max={speedMax} />
                <td class="num">{m.tokensPerSecond > 0 ? m.tokensPerSecond.toLocaleString() : "-"}</td>
                <td class="num">{m.calls.toLocaleString()}</td>
                <td class="num">{percent(m.errors, m.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Ranked title="단계별 시간" rows={data.steps} table={(rows) => <StepTable steps={rows} />}>
        <p class="muted small-text">
          턴 안의 LLM 호출·도구 실행과 그 아래 sandboxd·mcp-broker의 처리입니다. 쓴 시간이 큰 순서이고, 아래 단계의 시간은 위 단계에도 들어 있습니다.
        </p>
        <Legend
          items={[
            { kind: "llm", label: "LLM 호출" },
            { kind: "tool", label: "도구 실행" },
            { kind: "other", label: "그 아래 처리" },
          ]}
        />
      </Ranked>
      <Section title="가장 오래 걸린 턴">
        <table class="table chart">
          <thead>
            <tr>
              <th>시작</th>
              <th class="num">턴</th>
              <th colSpan={2}>시간</th>
              <th>세션</th>
            </tr>
          </thead>
          <tbody>
            {data.slowest.map((t) => (
              <tr key={`${t.sessionId} ${t.startedAt}`} class="clickable" onClick={() => (location.hash = `#/history/${enc(t.sessionId)}`)}>
                <td>{formatTime(t.startedAt)}</td>
                <td class="num">{t.turn ?? "-"}</td>
                <Bar kind="other" value={t.durationMs} max={slowestMax} />
                <td class="num">{duration(t.durationMs)}</td>
                <td class="clip mono muted">
                  {t.error && <Badge tone="red">실패</Badge>} {t.sessionId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function StepTable(props: { steps: Step[] }) {
  const totalMax = maxOf(props.steps.map((s) => s.totalMs));
  const onceMax = maxOf(props.steps.map((s) => s.ms.p95));
  return (
    <table class="table chart">
      <thead>
        <tr>
          <th>단계</th>
          <th colSpan={2}>시간 합계</th>
          <th colSpan={2}>한 번 (중앙값 · p95)</th>
          <th class="num">호출</th>
          <th class="num">오류율</th>
        </tr>
      </thead>
      <tbody>
        {props.steps.map((s) => (
          <tr key={`${s.service} ${s.name}`}>
            <td class="clip mono" title={`${s.service} · ${s.name}`}>
              {s.name}
            </td>
            <Bar kind={kindOf(s.name)} value={s.totalMs} max={totalMax} />
            <td class="num">{duration(s.totalMs)}</td>
            <Bar kind={kindOf(s.name)} value={s.ms.p50} upTo={s.ms.p95} max={onceMax} />
            <td class="num">
              {duration(s.ms.p50)} · {duration(s.ms.p95)}
            </td>
            <td class="num">{s.calls.toLocaleString()}</td>
            <td class="num">{percent(s.errors, s.calls)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 시간대별 턴 시간(중앙값·p95)의 선과 턴 수의 막대. 칸에 올리면 그 칸의 값이 범례에 나온다. */
function Trend(props: { timeline: Timeline }) {
  const { stepMs, buckets } = props.timeline;
  const [hover, setHover] = useState<number | null>(null);
  const peak = maxOf(buckets.map((b) => b.turnMs.p95));
  const top = AXIS_TOPS.find((t) => t >= peak) ?? peak;
  const mostTurns = maxOf(buckets.map((b) => b.turns));
  const x = (i: number) => ((i + 0.5) / buckets.length) * 100;
  const y = (ms: number) => 100 - (ms / top) * 100;
  // 턴이 없는 칸에서 선이 끊긴다
  const line = (p: keyof Percentiles) => buckets.map((b, i) => (b.turns === 0 ? "" : `${buckets[i - 1]?.turns ? "L" : "M"}${x(i)} ${y(b.turnMs[p])}`)).join("");
  // 선이 되지 못하는 외딴 칸과 올려 둔 칸에는 점을 찍는다
  const dotted = buckets.flatMap((b, i) => (b.turns > 0 && (i === hover || (!buckets[i - 1]?.turns && !buckets[i + 1]?.turns)) ? [i] : []));
  const at = hover === null ? undefined : buckets[hover];
  const value = (text: (b: Timeline["buckets"][number]) => string) => (at ? (at.turns > 0 ? text(at) : "-") : undefined);
  const labelEvery = Math.ceil(buckets.length / 4);
  return (
    <>
      <p class="muted small-text">턴을 시작한 시각으로 {stepMs >= 3_600_000 ? `${stepMs / 3_600_000}시간` : `${stepMs / 60_000}분`}씩 묶었습니다. 턴이 없는 칸에서는 선이 끊깁니다.</p>
      <Legend
        items={[
          { kind: "p50", label: "중앙값", value: value((b) => duration(b.turnMs.p50)) },
          { kind: "p95", label: "p95", value: value((b) => duration(b.turnMs.p95)) },
          { kind: "other", label: "턴 수", value: at && `${at.turns.toLocaleString()}개` },
        ]}
      >
        {at && <li class="muted">{formatTime(at.start).slice(5)}부터</li>}
      </Legend>
      <div class="trend">
        <div class="trend-axis">
          <span>{duration(top)}</span>
          <span>{duration(top / 2)}</span>
          <span>0</span>
        </div>
        <div class="trend-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="k-p95" d={line("p95")} />
            <path class="k-p50" d={line("p50")} />
          </svg>
          {dotted.flatMap((i) =>
            (["p95", "p50"] as const).map((p) => <i key={`${i} ${p}`} class={`trend-dot k-${p}`} style={{ left: `${x(i)}%`, top: `${y(buckets[i]!.turnMs[p])}%` }} />),
          )}
        </div>
        <div class="trend-axis">
          <span>{mostTurns.toLocaleString()}개</span>
        </div>
        <div class="trend-count">
          {buckets.map((b) => (
            <span key={b.start}>{b.turns > 0 && <i style={{ height: `${(b.turns / mostTurns) * 100}%` }} />}</span>
          ))}
        </div>
        <div class="trend-hover" onMouseLeave={() => setHover(null)}>
          {buckets.map((b, i) => (
            <i key={b.start} class={i === hover ? "on" : ""} onMouseEnter={() => setHover(i)} />
          ))}
        </div>
        <div class="trend-time">
          {buckets.map((b, i) => i % labelEvery === 0 && <span key={b.start} style={{ left: `${(i / buckets.length) * 100}%` }}>{formatTime(b.start).slice(5)}</span>)}
        </div>
      </div>
    </>
  );
}

/** 표의 막대 칸. 길이는 그 열의 가장 큰 값(max)에 대한 value이고, upTo가 있으면 거기까지 가는 선이 이어진다 (중앙값 뒤의 p95). 값은 옆 칸에 적는다. */
function Bar(props: { kind: Kind; value: number; upTo?: number; max: number }) {
  const width = (value: number) => `${props.max > 0 ? (value / props.max) * 100 : 0}%`;
  return (
    <td class="bar-cell" aria-hidden="true">
      <span class={`bar k-${props.kind}`}>
        {props.upTo !== undefined && props.upTo > 0 && <i class="upto" style={{ width: width(props.upTo) }} />}
        {props.value > 0 && <i style={{ width: width(props.value) }} />}
      </span>
    </td>
  );
}

/** 색이 무엇인지: 색 조각과 이름, 있으면 그 값 */
function Legend(props: { items: { kind: Mark; label: string; value?: string }[]; children?: ComponentChildren }) {
  return (
    <ul class="legend">
      {props.items.map((item) => (
        <li key={item.kind}>
          <i class={`k-${item.kind}`} />
          {item.label}
          {item.value && <span class="muted">{item.value}</span>}
        </li>
      ))}
      {props.children}
    </ul>
  );
}
