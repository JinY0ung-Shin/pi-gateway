import { useState } from "preact/hooks";
import { formatBytes, formatTime } from "../api";
import { Badge, Modal, Notice, Section, useLoad } from "../components";
import type { ServiceCheck, StatusView, ToolStat } from "../types";

/** 상태 화면에 바로 보이는 도구 수. 나머지는 전체 보기에서 */
const TOP_TOOLS = 10;

export function StatusPage() {
  const { data: status, error } = useLoad<StatusView>("/status", 10_000);

  if (error && !status) return <Notice tone="error">{error}</Notice>;
  if (!status) return <p class="muted">불러오는 중…</p>;
  const uptimeH = Math.floor(status.process.uptimeSeconds / 3600);
  const uptimeM = Math.floor((status.process.uptimeSeconds % 3600) / 60);

  const { services } = status;
  return (
    <>
      {error && <Notice tone="warn">새로고침 실패: {error}</Notice>}
      <Section title="연결 상태">
        <table class="table compact">
          <tbody>
            {services.llm.length === 0 && (
              <tr>
                <th>LLM</th>
                <td>
                  <Badge tone="amber">설정 안 됨</Badge> <a href="#/llm">LLM 화면</a>에서 서버를 등록하세요.
                </td>
              </tr>
            )}
            {services.llm.map((s) => (
              <tr key={s.id}>
                <th>
                  LLM <a class="mono" href="#/llm">{s.id}</a>
                </th>
                <td>
                  <Check check={s} />
                  {s.ok && <span class="muted small-text"> · 모델 {s.models}개</span>}
                  {s.missingModels.length > 0 && <Badge tone="amber">{`서버에 없는 모델: ${s.missingModels.join(", ")}`}</Badge>}
                </td>
              </tr>
            ))}
            <tr>
              <th>
                <a href="#/mcp">MCP broker</a>
              </th>
              <td>
                <Check check={services.broker} />
              </td>
            </tr>
            <tr>
              <th>sandboxd</th>
              <td>
                <Check check={services.sandboxd} />
              </td>
            </tr>
          </tbody>
        </table>
      </Section>
      <div class="stats">
        <Stat label="메모리의 세션" value={status.stats.liveSessions} />
        <Stat label="실행 중인 턴" value={status.stats.activeTurns} />
        <Stat label="대기 중인 턴" value={status.stats.queuedTurns} />
        <Stat label="활성 sandbox" value={status.sandboxes.items.filter((s) => s.state === "running").length} />
        <Stat label="gateway RSS" value={formatBytes(status.process.rssBytes)} />
        <Stat label="heap" value={`${formatBytes(status.process.heapUsedBytes)} / ${formatBytes(status.process.heapTotalBytes)}`} />
      </div>
      <Section title="구성">
        <table class="table compact">
          <tbody>
            <tr>
              <td>가동 시간</td>
              <td>
                {uptimeH}시간 {uptimeM}분 · Node {status.process.nodeVersion}
              </td>
            </tr>
            <tr>
              <td>시스템 프롬프트</td>
              <td>{status.prompt.isDefault ? <Badge tone="green">기본 프롬프트</Badge> : <Badge tone="blue">{`${status.prompt.name} v${status.prompt.version}`}</Badge>}</td>
            </tr>
            <tr>
              <td>plugin</td>
              <td>
                {status.plugins.enabled} / {status.plugins.installed} 사용 중
              </td>
            </tr>
          </tbody>
        </table>
      </Section>
      <ToolStats tools={status.tools} turns={status.turns} />
      <Section title="sandbox">
        {status.sandboxes.error && <Notice tone="error">sandboxd 조회 실패: {status.sandboxes.error}</Notice>}
        <table class="table">
          <thead>
            <tr>
              <th>key</th>
              <th>컨테이너</th>
              <th>상태</th>
              <th>마지막 사용</th>
            </tr>
          </thead>
          <tbody>
            {status.sandboxes.items.length === 0 && (
              <tr>
                <td colSpan={4} class="muted">
                  실행 중인 sandbox가 없습니다.
                </td>
              </tr>
            )}
            {status.sandboxes.items.map((s) => (
              <tr key={s.key}>
                <td class="mono">{s.key}</td>
                <td class="mono small-text">{s.containerName}</td>
                <td>{s.state === "running" ? <Badge tone="green">running</Badge> : <Badge>{s.state}</Badge>}</td>
                <td>{formatTime(s.lastActiveAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function ToolStats(props: { tools: ToolStat[]; turns: StatusView["turns"] }) {
  const [all, setAll] = useState(false);
  const { tools, turns } = props;
  const more = tools.length > TOP_TOOLS && (
    <button class="small" onClick={() => setAll(true)}>
      전체 {tools.length}개 보기
    </button>
  );
  return (
    <Section title="도구 사용 (최근 30일)" actions={more}>
      <p class="muted small-text">
        턴 {turns.turns.toLocaleString()}개 · 재생성·수정 {turns.branched.toLocaleString()}개
        {turns.turns > 0 && ` (${((turns.branched / turns.turns) * 100).toFixed(1)}%)`}
      </p>
      <ToolTable tools={tools.slice(0, TOP_TOOLS)} />
      {all && (
        <Modal title="도구 사용 (최근 30일)" onClose={() => setAll(false)}>
          <ToolTable tools={tools} />
        </Modal>
      )}
    </Section>
  );
}

function ToolTable(props: { tools: ToolStat[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>도구</th>
          <th class="num">호출</th>
          <th class="num">오류율</th>
          <th class="num">평균 시간</th>
        </tr>
      </thead>
      <tbody>
        {props.tools.length === 0 && (
          <tr>
            <td colSpan={4} class="muted">
              아직 호출된 도구가 없습니다.
            </td>
          </tr>
        )}
        {props.tools.map((t) => (
          <tr key={t.tool}>
            <td class="mono">{t.tool}</td>
            <td class="num">{t.calls.toLocaleString()}</td>
            <td class="num">{t.errors > 0 ? `${((t.errors / t.calls) * 100).toFixed(1)}%` : "0%"}</td>
            <td class="num">{t.avgMs < 1000 ? `${t.avgMs}ms` : `${(t.avgMs / 1000).toFixed(1)}s`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Check(props: { check: ServiceCheck }) {
  const { check } = props;
  if (check.ok) {
    return (
      <>
        <Badge tone="green">정상</Badge> <span class="muted small-text">{check.durationMs}ms</span>
      </>
    );
  }
  return (
    <>
      <Badge tone="red">응답 없음</Badge> <span class="small-text err-text">{check.error}</span>
    </>
  );
}

function Stat(props: { label: string; value: string | number }) {
  return (
    <div class="card stat">
      <div class="stat-value">{props.value}</div>
      <div class="muted small-text">{props.label}</div>
    </div>
  );
}
