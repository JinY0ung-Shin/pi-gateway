import { useEffect, useState } from "preact/hooks";
import { api, errorText, formatBytes, formatTime } from "../api";
import { Badge, Notice, Section } from "../components";
import type { ServiceCheck, StatusView } from "../types";

export function StatusPage() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await api<StatusView>("GET", "/status");
        if (alive) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(errorText(err));
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

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
