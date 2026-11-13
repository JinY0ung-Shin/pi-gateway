import { enc, formatTime } from "../api";
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
  models: { model: string; calls: number; errors: number; firstTokenMs: Percentiles; tokensPerSecond: number }[];
  steps: Step[];
  slowest: { sessionId: string; turn?: number; startedAt: string; durationMs: number; error: boolean }[];
}

interface Step {
  service: string;
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  ms: Percentiles;
}

const duration = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}시간` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}분` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`;
const percent = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-");

export function TimingPage() {
  const { data, error } = useLoad<TraceStats>("/traces/stats");

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p class="muted">불러오는 중…</p>;
  if (data.turns === 0) return <p class="muted">남아 있는 기록이 없습니다. 실행 시간 기록은 7일 동안 보관합니다.</p>;

  const total = data.share.llmMs + data.share.toolMs + data.share.otherMs;
  return (
    <>
      <p class="muted small-text">
        {formatTime(data.since)}부터의 턴 {data.turns.toLocaleString()}개로 냈습니다
        {data.turns >= data.limit ? ` (최근 ${data.limit}개까지만 셉니다)` : " (기록은 7일 동안 보관합니다)"}. p95는 100번 중 95번이 이 시간 안에 끝났다는 뜻입니다.
      </p>
      <div class="stats">
        <Stat label="턴" value={data.turns.toLocaleString()} />
        <Stat label="턴 시간 (중앙값)" value={duration(data.turnMs.p50)} />
        <Stat label="턴 시간 (p95)" value={duration(data.turnMs.p95)} />
        <Stat label="첫 token까지 (중앙값)" value={duration(data.firstTokenMs.p50)} />
        <Stat label="첫 token까지 (p95)" value={duration(data.firstTokenMs.p95)} />
        <Stat label="실패한 턴" value={percent(data.failed, data.turns)} />
      </div>
      <Section title="시간이 쓰인 곳">
        <table class="table">
          <thead>
            <tr>
              <th>구분</th>
              <th class="num">시간</th>
              <th class="num">비중</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["LLM 호출", data.share.llmMs],
                ["도구 실행", data.share.toolMs],
                ["그 외 (세션 준비, 요약 등)", data.share.otherMs],
              ] as const
            ).map(([label, ms]) => (
              <tr key={label}>
                <td class="clip">{label}</td>
                <td class="num">{duration(ms)}</td>
                <td class="num">{percent(ms, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="모델별 응답 속도">
        <table class="table">
          <thead>
            <tr>
              <th>모델</th>
              <th class="num">호출</th>
              <th class="num">첫 token (중앙값)</th>
              <th class="num">첫 token (p95)</th>
              <th class="num">출력 속도</th>
              <th class="num">오류율</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.model}>
                <td class="clip mono" title={m.model}>
                  {m.model}
                </td>
                <td class="num">{m.calls.toLocaleString()}</td>
                <td class="num">{duration(m.firstTokenMs.p50)}</td>
                <td class="num">{duration(m.firstTokenMs.p95)}</td>
                <td class="num">{m.tokensPerSecond > 0 ? `${m.tokensPerSecond} token/초` : "-"}</td>
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
      </Ranked>
      <Section title="가장 오래 걸린 턴">
        <table class="table">
          <thead>
            <tr>
              <th>시작</th>
              <th class="num">턴</th>
              <th class="num">시간</th>
              <th>세션</th>
            </tr>
          </thead>
          <tbody>
            {data.slowest.map((t) => (
              <tr key={`${t.sessionId} ${t.startedAt}`} class="clickable" onClick={() => (location.hash = `#/history/${enc(t.sessionId)}`)}>
                <td>{formatTime(t.startedAt)}</td>
                <td class="num">{t.turn ?? "-"}</td>
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
  return (
    <table class="table">
      <thead>
        <tr>
          <th>단계</th>
          <th class="num">호출</th>
          <th class="num">시간 합계</th>
          <th class="num">중앙값</th>
          <th class="num">p95</th>
          <th class="num">오류율</th>
        </tr>
      </thead>
      <tbody>
        {props.steps.map((s) => (
          <tr key={`${s.service} ${s.name}`}>
            <td class="clip mono" title={`${s.service} · ${s.name}`}>
              {s.name}
            </td>
            <td class="num">{s.calls.toLocaleString()}</td>
            <td class="num">{duration(s.totalMs)}</td>
            <td class="num">{duration(s.ms.p50)}</td>
            <td class="num">{duration(s.ms.p95)}</td>
            <td class="num">{percent(s.errors, s.calls)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
