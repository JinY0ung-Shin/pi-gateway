import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { api, duration, enc, formatTime, percent } from "../api";
import { Badge, EmptyRow, Modal, Notice, Section, useAction, useLoad } from "../components";

/** 프로세스 마이닝: 실행(지금 실행, 자동 실행 시각, 이력), 프로세스 목록과 수정, 변경 이력, 그 작업 */

interface Run {
  id: number;
  trigger: "manual" | "schedule";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "requested" | "running" | "completed" | "time_limit" | "aborted" | "failed";
  processed: number | null;
  failed: number | null;
  remaining: number | null;
  episodes: number | null;
  model: string | null;
  error: string | null;
  /** 이 실행이 프로세스에 한 변경 수 */
  changes: number;
}

interface Revision {
  id: number;
  at: string;
  /** 사람이 했으면 null */
  runId: number | null;
  labelId: number;
  kind: "created" | "refined" | "split" | "merged" | "deleted";
  name: string;
  before: string | null;
  after: string | null;
  reason: string | null;
}

interface Label {
  id: number;
  name: string;
  criteria: string;
  createdAt: string;
  /** 사람이 이름·기준을 고친 때 */
  editedAt: string | null;
  flow: string[] | null;
  total: number;
  recent7: number;
  recent30: number;
  users: number;
}

interface Overview {
  runs: Run[];
  /** "HH:MM" (UTC) */
  dailyAt: string | null;
  labels: Label[];
  revisions: Revision[];
  recent30: number;
  unlabeled30: number;
}

interface Episode {
  id: number;
  sessionId: string;
  /** 세션이 지워졌으면 null */
  user: string | null;
  endedAt: string;
  goal: string;
  steps: string[];
  labelId: number | null;
}

const STATUS: Record<Run["status"], { text: string; tone: "blue" | "green" | "gray" | "amber" | "red" }> = {
  requested: { text: "시작 대기", tone: "gray" },
  running: { text: "실행 중", tone: "blue" },
  completed: { text: "완료", tone: "green" },
  time_limit: { text: "시간 상한", tone: "amber" },
  aborted: { text: "LLM 실패로 중단", tone: "red" },
  failed: { text: "실패", tone: "red" },
};
const UNLABELED = "미분류";
const KIND: Record<Revision["kind"], string> = { created: "생김", refined: "고침", split: "나뉨", merged: "합쳐짐", deleted: "지워짐" };

/** 변경 하나를 한 줄로 */
function revisionText(r: Revision): string {
  if (r.kind === "created") return r.before ? `"${r.before}"에서 나뉨: ${r.after}` : (r.after ?? "");
  if (r.kind === "refined") return `${r.before} → ${r.after}`;
  if (r.kind === "split") return `→ ${r.after}`;
  if (r.kind === "merged") return `"${r.after}"(으)로 합쳐짐`;
  return r.before ?? "";
}

/** "HH:MM"을 UTC와 브라우저 시간대 사이에서 바꾼다. */
function shiftTime(time: string, to: "utc" | "local"): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  if (to === "utc") {
    d.setHours(h, m, 0, 0);
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  d.setUTCHours(h, m, 0, 0);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function MiningPage() {
  const { data, error, reload } = useLoad<Overview>("/mining", 10_000);
  /** 열어 둔 프로세스: 라벨 id, 또는 "none"(미분류) */
  const [open, setOpen] = useState<number | "none" | null>(null);

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p class="muted">불러오는 중…</p>;
  const running = data.runs.some((r) => r.status === "running");
  const label = data.labels.find((l) => l.id === open);
  return (
    <>
      {error && <Notice tone="warn">{error}</Notice>}
      <RunSection data={data} reload={reload} />
      <LabelSection data={data} onOpen={setOpen} />
      <Section title="변경 이력" actions={<span class="muted small-text">실행이 스스로 한 것과 사람이 한 것, 최근 {data.revisions.length}건</span>}>
        <Revisions items={data.revisions} />
      </Section>
      <EpisodeSection labels={data.labels} />
      {open === "none" && (
        <Modal title={UNLABELED} onClose={() => setOpen(null)}>
          <p class="muted small-text">어느 프로세스에도 들지 않은 작업입니다. 20건 이상 쌓이면 다음 실행이 여기서 새 프로세스를 찾습니다.</p>
          <Episodes path="/mining/episodes?label=none" />
        </Modal>
      )}
      {label && (
        <LabelModal
          key={label.id}
          label={label}
          others={data.labels.filter((l) => l.id !== label.id)}
          revisions={data.revisions.filter((r) => r.labelId === label.id)}
          running={running}
          reload={reload}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function RunSection(props: { data: Overview; reload: () => Promise<void> }) {
  const { runs, dailyAt } = props.data;
  const saved = dailyAt ? shiftTime(dailyAt, "local") : "";
  const [time, setTime] = useState(saved);
  const action = useAction();
  const active = runs.find((r) => r.status === "requested" || r.status === "running");

  const start = () =>
    action.run(async () => {
      await api("POST", "/mining/run");
      await props.reload();
    }, "실행을 요청했습니다. mining 서비스가 10초 안에 시작합니다.");
  const save = (next: string) =>
    action.run(async () => {
      await api("PUT", "/mining/schedule", { dailyAt: next ? shiftTime(next, "utc") : null });
      setTime(next);
      await props.reload();
    }, next ? "저장했습니다." : "자동 실행을 껐습니다.");

  return (
    <Section
      title="실행"
      actions={
        <button class="primary" disabled={action.busy || Boolean(active)} onClick={() => void start()}>
          {active ? STATUS[active.status].text : "지금 실행"}
        </button>
      }
    >
      {action.view}
      <div class="row">
        <span>매일</span>
        <input type="time" value={time} aria-label="자동 실행 시각" onInput={(e) => setTime(e.currentTarget.value)} />
        <span>에 자동 실행</span>
        <button disabled={action.busy || !time || time === saved} onClick={() => void save(time)}>
          저장
        </button>
        {saved && (
          <button disabled={action.busy} onClick={() => void save("")}>
            끄기
          </button>
        )}
        <span class="muted small-text">{saved ? `현재: 매일 ${saved} (이 브라우저의 시간대)` : "현재: 자동으로 실행하지 않음"}</span>
      </div>
      <p class="muted small-text">
        한 번 실행하면 마지막 활동이 30일 안이고 30분 넘게 쉰 세션 중 새 내용이 있는 것을 읽어 작업을 뽑고, 프로세스에 붙이고, 새 프로세스를 찾고, 근거가 쌓인 프로세스를 다시 검토해
        고치거나 나눕니다. 최대 3시간 돌고, 못 읽은 세션은 다음 실행이 이어 갑니다.
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>요청</th>
            <th>계기</th>
            <th>결과</th>
            <th class="num">걸린 시간</th>
            <th class="num">읽은 세션</th>
            <th class="num">실패</th>
            <th class="num">남음</th>
            <th class="num">작업</th>
            <th class="num">변경</th>
            <th>모델</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && <EmptyRow cols={10}>아직 실행한 적이 없습니다.</EmptyRow>}
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{formatTime(r.requestedAt)}</td>
              <td>{r.trigger === "manual" ? "수동" : "자동"}</td>
              <td>
                <Badge tone={STATUS[r.status].tone} title={r.error ?? undefined}>
                  {STATUS[r.status].text}
                </Badge>
              </td>
              <td class="num">{r.startedAt && r.finishedAt ? duration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : "-"}</td>
              <td class="num">{r.processed ?? "-"}</td>
              <td class="num">{r.failed ?? "-"}</td>
              <td class="num">{r.remaining ?? "-"}</td>
              <td class="num">{r.episodes ?? "-"}</td>
              <td class="num">{r.changes}</td>
              <td class="clip mono muted">{r.error ?? r.model ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function LabelSection(props: { data: Overview; onOpen: (id: number | "none") => void }) {
  const { labels, recent30, unlabeled30 } = props.data;
  const sorted = [...labels].sort((a, b) => b.recent30 - a.recent30 || a.id - b.id);
  return (
    <Section title={`프로세스 (${labels.length}개)`} actions={<span class="muted small-text">최근 30일 작업 {recent30}건 · 미분류율 {percent(unlabeled30, recent30)}</span>}>
      <table class="table">
        <thead>
          <tr>
            <th>프로세스</th>
            <th>기준</th>
            <th class="num">7일</th>
            <th class="num">30일</th>
            <th class="num">전체</th>
            <th class="num">사용자</th>
            <th>생긴 때</th>
          </tr>
        </thead>
        <tbody>
          {labels.length === 0 && <EmptyRow cols={7}>아직 없습니다. 미분류 작업이 20건 이상 쌓이면 실행할 때 찾습니다.</EmptyRow>}
          {sorted.map((l) => (
            <tr key={l.id} class="clickable" onClick={() => props.onOpen(l.id)}>
              <td>{l.name}</td>
              <td class="clip muted">{l.criteria}</td>
              <td class="num">{l.recent7}</td>
              <td class="num">{l.recent30}</td>
              <td class="num">{l.total}</td>
              <td class="num">{l.users}</td>
              <td>{formatTime(l.createdAt)}</td>
            </tr>
          ))}
          <tr class="clickable" onClick={() => props.onOpen("none")}>
            <td class="muted">{UNLABELED}</td>
            <td class="clip muted">어느 프로세스에도 들지 않은 작업</td>
            <td class="num">-</td>
            <td class="num">{unlabeled30}</td>
            <td class="num">-</td>
            <td class="num">-</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

/** 프로세스 하나: 이름·기준 수정, 합치기, 지우기, 대표 흐름, 그 작업 */
function LabelModal(props: { label: Label; others: Label[]; revisions: Revision[]; running: boolean; reload: () => Promise<void>; onClose: () => void }) {
  const { label } = props;
  const [name, setName] = useState(label.name);
  const [criteria, setCriteria] = useState(label.criteria);
  const [into, setInto] = useState("");
  const action = useAction();
  const locked = action.busy || props.running;

  const save = () =>
    action.run(async () => {
      await api("PUT", `/mining/labels/${label.id}`, { name, criteria });
      await props.reload();
    }, "저장했습니다. 다음 실행부터 이 기준으로 작업을 붙이고, 자동 검토는 이 프로세스의 이름·기준을 바꾸지 않습니다.");
  /** 합치거나 지우면 이 프로세스가 없어지므로 창을 닫는다. */
  const remove = async (request: () => Promise<unknown>) => {
    const done = await action.run(async () => {
      await request();
      await props.reload();
      return true;
    });
    if (done) props.onClose();
  };

  return (
    <Modal title={label.name} onClose={props.onClose}>
      {action.view}
      {props.running && <Notice tone="info">실행 중에는 고칠 수 없습니다.</Notice>}
      {label.editedAt && <p class="muted small-text">사람이 {formatTime(label.editedAt)}에 고쳤습니다. 자동 검토가 이름·기준을 바꾸지 않습니다.</p>}
      <label class="field">
        <span>이름</span>
        <input value={name} maxLength={60} disabled={locked} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>기준 (어떤 작업이 여기에 드는지. 실행할 때 모델이 이 글을 보고 작업을 붙입니다)</span>
        <textarea rows={3} value={criteria} maxLength={300} disabled={locked} onInput={(e) => setCriteria(e.currentTarget.value)} />
      </label>
      <div class="row">
        <button class="primary" disabled={locked || !name.trim() || !criteria.trim() || (name === label.name && criteria === label.criteria)} onClick={() => void save()}>
          저장
        </button>
        <select value={into} disabled={locked || props.others.length === 0} aria-label="합칠 프로세스" onChange={(e) => setInto(e.currentTarget.value)}>
          <option value="">다른 프로세스로 합치기…</option>
          {props.others.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          disabled={locked || !into}
          onClick={() =>
            confirm(`"${label.name}"의 작업 ${label.total}건을 "${props.others.find((l) => String(l.id) === into)?.name}"(으)로 옮기고 이 프로세스를 없앨까요?`) &&
            void remove(() => api("POST", `/mining/labels/${label.id}/merge`, { into: Number(into) }))
          }
        >
          합치기
        </button>
        <button
          class="danger"
          disabled={locked}
          onClick={() =>
            confirm(`"${label.name}"을(를) 지울까요? 작업 ${label.total}건은 다음 실행이 다른 프로세스에 다시 붙여 봅니다.`) &&
            void remove(() => api("DELETE", `/mining/labels/${label.id}`))
          }
        >
          지우기
        </button>
      </div>
      <h3>대표 흐름</h3>
      {label.flow ? (
        <ol>
          {label.flow.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      ) : (
        <p class="muted">아직 없습니다. 실행할 때 씁니다.</p>
      )}
      <h3>변경 이력</h3>
      <Revisions items={props.revisions} />
      <h3>작업</h3>
      <Episodes path={`/mining/episodes?label=${label.id}`} />
    </Modal>
  );
}

/** 프로세스에 일어난 변경. 자동 검토가 적은 이유가 있으면 같이 보여 준다. */
function Revisions(props: { items: Revision[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>때</th>
          <th>누가</th>
          <th>변경</th>
          <th>프로세스</th>
          <th>내용</th>
        </tr>
      </thead>
      <tbody>
        {props.items.length === 0 && <EmptyRow cols={5}>아직 변경이 없습니다.</EmptyRow>}
        {props.items.map((r) => {
          const text = `${revisionText(r)}${r.reason ? ` (${r.reason})` : ""}`;
          return (
            <tr key={r.id}>
              <td>{formatTime(r.at)}</td>
              <td>{r.runId === null ? "사람" : "자동"}</td>
              <td>{KIND[r.kind]}</td>
              <td>{r.name}</td>
              <td class="clip" title={text}>
                {text}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EpisodeSection(props: { labels: Label[] }) {
  const [user, setUser] = useState("");
  const [path, setPath] = useState("/mining/episodes");
  const load = () => setPath(`/mining/episodes${user.trim() ? `?user=${enc(user.trim())}` : ""}`);
  return (
    <Section title="작업">
      <div class="row">
        <input class="mono grow" value={user} placeholder="user (비우면 전체)" onInput={(e) => setUser(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
        <button onClick={load}>조회</button>
      </div>
      <Episodes path={path} labels={props.labels} />
    </Section>
  );
}

/** 작업 목록. 줄을 누르면 단계와 그 대화로 가는 링크가 펼쳐진다. labels를 주면 프로세스 칸과 프로세스별 건수를 보여 준다. */
function Episodes(props: { path: string; labels?: Label[] }) {
  const { data, error } = useLoad<{ items: Episode[]; total: number }>(props.path);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p class="muted">불러오는 중…</p>;

  const names = new Map(props.labels?.map((l) => [l.id, l.name]));
  const nameOf = (e: Episode) => (e.labelId === null ? UNLABELED : (names.get(e.labelId) ?? UNLABELED));
  const counts = new Map<string, number>();
  if (props.labels) for (const e of data.items) counts.set(nameOf(e), (counts.get(nameOf(e)) ?? 0) + 1);
  const cols = props.labels ? 4 : 3;
  return (
    <>
      <p class="muted small-text">
        {data.total}건{data.total > data.items.length && ` 중 최근 ${data.items.length}건`}
        {counts.size > 0 && `: ${[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}건`).join(", ")}`}
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>끝난 때</th>
            <th>user</th>
            {props.labels && <th>프로세스</th>}
            <th>목표</th>
          </tr>
        </thead>
        <tbody>
          {data.items.length === 0 && <EmptyRow cols={cols}>작업이 없습니다.</EmptyRow>}
          {data.items.map((e) => (
            <Fragment key={e.id}>
              <tr class="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <td>{formatTime(e.endedAt)}</td>
                <td class="mono">{e.user ?? "-"}</td>
                {props.labels && <td>{nameOf(e)}</td>}
                <td class="clip">{e.goal}</td>
              </tr>
              {open === e.id && (
                <tr>
                  <td colSpan={cols}>
                    <p>{e.goal}</p>
                    <ol>
                      {e.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    {e.user && <a href={`#/history/${enc(e.sessionId)}`}>대화 보기</a>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}
