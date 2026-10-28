import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { api, enc, formatBytes, formatTime } from "../api";
import { Badge, Modal, Notice, Section, useAction, useLoad } from "../components";
import type { ServiceCheck, StatusView, ToolStat, UserUsage } from "../types";

/** 통계 표에 바로 보이는 줄 수. 나머지는 전체 보기에서 */
const TOP_ROWS = 10;

export function StatusPage() {
  const { data: status, error, reload } = useLoad<StatusView>("/status", 10_000);

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
      {status.activeTurns.length > 0 && <ActiveTurns turns={status.activeTurns} reload={reload} />}
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
      <Ranked title="도구 사용 (최근 30일)" rows={status.tools} table={(rows) => <ToolTable tools={rows} />}>
        <p class="muted small-text">
          턴 {status.turns.turns.toLocaleString()}개 · 재생성·수정 {status.turns.branched.toLocaleString()}개
          {status.turns.turns > 0 && ` (${((status.turns.branched / status.turns.turns) * 100).toFixed(1)}%)`}
        </p>
      </Ranked>
      <Ranked title="사용자별 토큰 (최근 30일)" rows={status.users} table={(rows) => <UserTable users={rows} />} />
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

function ActiveTurns(props: { turns: StatusView["activeTurns"]; reload: () => Promise<void> }) {
  const action = useAction();
  // 멈춘 턴은 그때까지의 내용을 남기고 incomplete(user_cancelled)로 끝난다.
  const stop = (t: StatusView["activeTurns"][number]) =>
    action.run(async () => {
      await api("POST", `/chat/${enc(t.responseId)}/cancel?user=${enc(t.user)}`);
      await props.reload();
    }, "중지했습니다.");
  return (
    <Section title="실행 중인 턴">
      {action.view}
      <table class="table">
        <thead>
          <tr>
            <th>사용자</th>
            <th>응답</th>
            <th class="num">경과</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.turns.map((t) => (
            <tr key={t.responseId}>
              <td>{t.user}</td>
              <td class="mono">{t.responseId}</td>
              <td class="num">{Math.round((Date.now() - Date.parse(t.startedAt)) / 1000)}초</td>
              <td class="actions">
                <button class="small danger" disabled={action.busy} onClick={() => void stop(t)}>
                  중지
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** 상위 TOP_ROWS줄만 보이고 나머지는 전체 보기 창에서 보는 표 */
function Ranked<T>(props: { title: string; rows: T[]; table: (rows: T[]) => JSX.Element; children?: ComponentChildren }) {
  const [all, setAll] = useState(false);
  const { rows } = props;
  const more = rows.length > TOP_ROWS && (
    <button class="small" onClick={() => setAll(true)}>
      전체 {rows.length}개 보기
    </button>
  );
  return (
    <Section title={props.title} actions={more}>
      {props.children}
      {props.table(rows.slice(0, TOP_ROWS))}
      {all && (
        <Modal title={props.title} onClose={() => setAll(false)}>
          {props.table(rows)}
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

function UserTable(props: { users: UserUsage[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>사용자</th>
          <th class="num">LLM 호출</th>
          <th class="num">입력 토큰</th>
          <th class="num">캐시 비율</th>
          <th class="num">출력 토큰</th>
        </tr>
      </thead>
      <tbody>
        {props.users.length === 0 && (
          <tr>
            <td colSpan={5} class="muted">
              아직 사용 기록이 없습니다.
            </td>
          </tr>
        )}
        {props.users.map((u) => (
          <tr key={u.user}>
            <td>{u.user}</td>
            <td class="num">{u.llmCalls.toLocaleString()}</td>
            <td class="num">{u.inputTokens.toLocaleString()}</td>
            <td class="num">{u.inputTokens > 0 ? `${((u.cachedTokens / u.inputTokens) * 100).toFixed(1)}%` : "-"}</td>
            <td class="num">{u.outputTokens.toLocaleString()}</td>
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
