import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { api, duration, enc, formatBytes, formatTime, percent } from "../api";
import { Badge, EmptyRow, Modal, Notice, Section, useAction, useLoad } from "../components";
import type { SearchStat, ServiceCheck, StatusView, ToolStat, UserUsage } from "../types";

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
      <div class="stats">
        <Stat label="메모리의 세션" value={status.stats.liveSessions} />
        <Stat label="실행 중인 턴" value={status.stats.activeTurns} />
        <Stat label="대기 중인 턴" value={status.stats.queuedTurns} />
        <Stat label="활성 sandbox" value={status.sandboxes.items.filter((s) => s.state === "running").length} />
        <Stat label="gateway RSS" value={formatBytes(status.process.rssBytes)} />
        <Stat label="heap" value={formatBytes(status.process.heapUsedBytes)} of={formatBytes(status.process.heapTotalBytes)} />
      </div>
      <Section title="연결 상태">
        <table class="table">
          <tbody>
            {services.llm.length === 0 && (
              <tr>
                <th>LLM</th>
                <td class="clip">
                  <Badge tone="amber">설정 안 됨</Badge> <a href="#/llm">LLM 화면</a>에서 서버를 등록하세요.
                </td>
              </tr>
            )}
            {services.llm.map((s) => (
              <tr key={s.id}>
                <th>
                  LLM{" "}
                  <a class="mono" href="#/llm">
                    {s.id}
                  </a>
                </th>
                <td class="clip">
                  <Check check={s} />
                  {s.ok && <span class="muted small-text"> · 모델 {s.models}개</span>}{" "}
                  {s.missingModels.length > 0 && <Badge tone="amber">{`서버에 없는 모델: ${s.missingModels.join(", ")}`}</Badge>}
                </td>
              </tr>
            ))}
            <tr>
              <th>
                <a href="#/mcp">MCP broker</a>
              </th>
              <td class="clip">
                <Check check={services.broker} />
              </td>
            </tr>
            <tr>
              <th>sandboxd</th>
              <td class="clip">
                <Check check={services.sandboxd} />
              </td>
            </tr>
          </tbody>
        </table>
      </Section>
      {status.activeTurns.length > 0 && <ActiveTurns turns={status.activeTurns} reload={reload} />}
      <Section title="구성">
        <table class="table">
          <tbody>
            <tr>
              <th>가동 시간</th>
              <td class="clip">
                {uptimeH}시간 {uptimeM}분 · Node {status.process.nodeVersion}
              </td>
            </tr>
            <tr>
              <th>시스템 프롬프트</th>
              <td class="clip">{status.prompt.isDefault ? <Badge tone="green">기본 프롬프트</Badge> : <Badge tone="blue">{`${status.prompt.name} v${status.prompt.version}`}</Badge>}</td>
            </tr>
            <tr>
              <th>plugin</th>
              <td class="clip">
                {status.plugins.enabled} / {status.plugins.installed} 사용 중
              </td>
            </tr>
          </tbody>
        </table>
      </Section>
      <Ranked title="도구 사용 (최근 30일)" rows={status.tools} table={(rows) => <ToolTable tools={rows} />}>
        <p class="muted small-text">
          턴 {status.turns.turns.toLocaleString()}개 · 재생성·수정 {status.turns.branched.toLocaleString()}개
          {status.turns.turns > 0 && ` (${percent(status.turns.branched, status.turns.turns)})`}
        </p>
      </Ranked>
      <Section title="MCP 검색 정확도 (최근 30일)">
        <p class="muted small-text">
          mcp_search 뒤에 모델이 처음 부른 MCP 도구가 검색 결과의 몇 번째 안에 있었는지입니다 (호출로 이어진 검색 기준). 정답이 아니라 모델이 고른 도구로 봅니다.
        </p>
        <SearchTable searches={status.searches} />
      </Section>
      <Ranked title="사용자별 토큰 (최근 30일)" rows={status.users} table={(rows) => <UserTable users={rows} />} />
      <Section title="sandbox">
        {services.sandboxd.error && <Notice tone="error">sandboxd 조회 실패: {services.sandboxd.error}</Notice>}
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
            {status.sandboxes.items.length === 0 && <EmptyRow cols={4}>실행 중인 sandbox가 없습니다.</EmptyRow>}
            {status.sandboxes.items.map((s) => (
              <tr key={s.key}>
                <td class="mono">{s.key}</td>
                <td class="clip mono">{s.containerName}</td>
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
              <td class="clip mono">{t.responseId}</td>
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
export function Ranked<T>(props: { title: string; rows: T[]; table: (rows: T[]) => JSX.Element; children?: ComponentChildren }) {
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
        {props.tools.length === 0 && <EmptyRow cols={4}>아직 호출된 도구가 없습니다.</EmptyRow>}
        {props.tools.map((t) => (
          <tr key={t.tool}>
            <td class="clip mono" title={t.tool}>
              {t.tool}
            </td>
            <td class="num">{t.calls.toLocaleString()}</td>
            <td class="num">{t.errors > 0 ? percent(t.errors, t.calls) : "0%"}</td>
            <td class="num">{duration(t.avgMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SearchTable(props: { searches: SearchStat[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>방식</th>
          <th class="num">검색</th>
          <th class="num">호출로 이어짐</th>
          <th class="num">top-1</th>
          <th class="num">top-2</th>
          <th class="num">top-3</th>
        </tr>
      </thead>
      <tbody>
        {props.searches.length === 0 && <EmptyRow cols={6}>아직 검색이 없습니다.</EmptyRow>}
        {props.searches.map((s) => (
          <tr key={s.method}>
            <td class="clip">{s.method === "model" ? "System One" : "BM25"}</td>
            <td class="num">{s.searches.toLocaleString()}</td>
            <td class="num">{s.called.toLocaleString()}</td>
            <td class="num">{percent(s.top1, s.called)}</td>
            <td class="num">{percent(s.top2, s.called)}</td>
            <td class="num">{percent(s.top3, s.called)}</td>
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
        {props.users.length === 0 && <EmptyRow cols={5}>아직 사용 기록이 없습니다.</EmptyRow>}
        {props.users.map((u) => (
          <tr key={u.user}>
            <td class="clip">{u.user}</td>
            <td class="num">{u.llmCalls.toLocaleString()}</td>
            <td class="num">{u.inputTokens.toLocaleString()}</td>
            <td class="num">{percent(u.cachedTokens, u.inputTokens)}</td>
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
      <Badge tone="red">응답 없음</Badge>{" "}
      <span class="small-text err-text" title={check.error}>
        {check.error}
      </span>
    </>
  );
}

/** 지금 수치 하나. of는 전체 크기 (heap 사용량 / 전체). */
export function Stat(props: { label: string; value: string | number; of?: string }) {
  return (
    <div class="stat">
      <div class="muted small-text">{props.label}</div>
      <div class="stat-value">
        {props.value}
        {props.of && <small> / {props.of}</small>}
      </div>
    </div>
  );
}
