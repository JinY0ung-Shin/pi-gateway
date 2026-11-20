import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, duration, enc, formatTime, percent, timeAgo } from "../api";
import { Badge, Bar, EmptyRow, Modal, Notice, rowAction, Section, Stat, Time, useAction, useLoad, usePaged } from "../components";

/** 프로세스 마이닝: 지금 수치, 실행(진행 상황, 지금 실행, 자동 실행 시각, 이력), 프로세스 목록과 수정, 그 작업, 변경 이력 */

/** gateway의 mining/store.ts Stage와 같다 */
type Stage = "extract" | "assign" | "discover" | "merge" | "review" | "reassign" | "flows" | "rename";

interface Run {
  id: number;
  trigger: "manual" | "schedule" | "rename";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: "requested" | "running" | "completed" | "time_limit" | "aborted" | "stopped" | "failed";
  /** 사람이 중지를 요청했다 (하던 LLM 호출을 마치고 멈춘다) */
  stopRequested: boolean;
  /** 실행 중에는 그때까지의 수 */
  processed: number | null;
  failed: number | null;
  remaining: number | null;
  episodes: number | null;
  model: string | null;
  error: string | null;
  /** 지금 하는 단계와 그 단계에서 마친 수 / 할 수. 끝난 실행에는 마지막 단계가 남는다 */
  stage: Stage | null;
  stageDone: number | null;
  stageTotal: number | null;
  /** 진행 상황을 마지막으로 적은 때 */
  progressAt: string | null;
  working: unknown[];
  /** 이 실행이 프로세스에 한 변경 수 */
  changes: number;
}

/** 지금 LLM에 보내 둔 호출 하나가 다루는 것: 읽는 세션, 붙이는 작업(목표), 검토하거나 흐름을 쓰는 프로세스(이름) */
type Working = { kind: "session"; sessionId: string; user: string | null } | { kind: "episode" | "label"; text: string };

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
  /** 요청됐거나 실행 중인 실행(지금 보낸 호출이 붙어 있다)과, 가장 최근에 끝난 실행 */
  active: (Omit<Run, "working"> & { working: Working[] }) | null;
  last: Run | null;
  /** 지금 실행하면 할 일: 읽을 세션 수와 프로세스에 붙여 볼 작업 수 */
  next: { sessions: number; episodes: number };
  /** "HH:MM" (UTC) */
  dailyAt: string | null;
  /** 한 실행이 LLM을 동시에 부르는 수 */
  concurrency: number;
  /** 실행이 쓰는 모델. null이면 gateway의 기본 모델 */
  model: string | null;
  /** 모든 LLM 호출의 시스템 프롬프트 끝에 붙이는 글. 없으면 null */
  prompt: string | null;
  labels: Label[];
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
  stopped: { text: "중지함", tone: "gray" },
  failed: { text: "실패", tone: "red" },
};
const TRIGGER: Record<Run["trigger"], string> = { manual: "수동", schedule: "자동", rename: "이름 다시 짓기" };
/** 실행이 지나가는 큰 단계. 둘째 단계는 한 실행에서 세 번까지 돈다. */
const PHASES: { label: string; stages: Stage[] }[] = [
  { label: "세션 읽기", stages: ["extract"] },
  { label: "작업 분류, 새 프로세스 찾기", stages: ["assign", "discover", "merge"] },
  { label: "프로세스 검토", stages: ["review", "reassign"] },
  { label: "대표 흐름 쓰기", stages: ["flows"] },
];
/** 지금 하는 일과, 셀 것이 있으면 그 단위 */
const STAGE: Record<Stage, { text: string; unit?: string }> = {
  extract: { text: "세션을 읽어 작업을 뽑는 중", unit: "세션" },
  assign: { text: "작업을 프로세스로 분류하는 중", unit: "작업" },
  discover: { text: "미분류 작업에서 새 프로세스를 찾는 중" },
  merge: { text: "새 프로세스가 기존 것과 겹치는지 보는 중" },
  review: { text: "근거가 쌓인 프로세스를 다시 검토하는 중", unit: "프로세스" },
  reassign: { text: "바뀐 기준으로 작업을 다시 분류하는 중", unit: "작업" },
  flows: { text: "대표 흐름을 쓰는 중", unit: "프로세스" },
  rename: { text: "프로세스 이름을 다시 짓는 중", unit: "프로세스" },
};
const phaseOf = (stage: Stage | null) => PHASES.findIndex((p) => stage !== null && p.stages.includes(stage));
/** LLM 호출 하나는 길어야 4분이다 (2분에 한 번 다시). 이보다 오래 진행이 없으면 눈에 띄게 한다 */
const STALLED_MS = 5 * 60_000;
/** mining 서비스는 10초마다 요청을 본다 */
const SLOW_START_MS = 60_000;
/** gateway의 MAX_CONCURRENCY와 같다 */
const MAX_CONCURRENCY = 16;
/** gateway의 PROMPT_CHARS와 같다 */
const PROMPT_CHARS = 4000;
const UNLABELED = "미분류";
const KIND: Record<Revision["kind"], { text: string; tone: "green" | "blue" | "violet" | "gray" | "red" }> = {
  created: { text: "생김", tone: "green" },
  refined: { text: "고침", tone: "blue" },
  split: { text: "나뉨", tone: "violet" },
  merged: { text: "합쳐짐", tone: "gray" },
  deleted: { text: "지워짐", tone: "red" },
};

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
  // 실행을 기다리거나 실행하는 동안에는 자주 다시 읽는다
  const [live, setLive] = useState(false);
  const { data, error, reload } = useLoad<Overview>("/mining", live ? 3_000 : 10_000);
  /** 열어 둔 프로세스: 라벨 id, 또는 "none"(미분류) */
  const [open, setOpen] = useState<number | "none" | null>(null);
  const active = data?.active ?? undefined;
  useEffect(() => setLive(Boolean(active)), [Boolean(active)]);

  if (!data) return error ? <Notice tone="error">{error}</Notice> : <p class="muted">불러오는 중…</p>;
  const label = data.labels.find((l) => l.id === open);
  const { last } = data;
  const saved = data.dailyAt ? shiftTime(data.dailyAt, "local") : "";
  return (
    <>
      {error && <Notice tone="warn">새로고침 실패: {error}</Notice>}
      <div class="stats">
        <Stat label="프로세스" value={data.labels.length} note="개" />
        <Stat label="최근 30일 작업" value={data.recent30.toLocaleString()} note="건" />
        <Stat label="미분류 (최근 30일)" value={percent(data.unlabeled30, data.recent30)} note={`${data.unlabeled30.toLocaleString()}건`} />
        <Stat
          label="마지막 실행"
          value={last ? STATUS[last.status].text : "-"}
          note={last && <Time at={last.finishedAt} />}
          tone={last?.status === "time_limit" ? "warn" : last?.status === "aborted" || last?.status === "failed" ? "err" : undefined}
        />
        <Stat label="자동 실행" value={saved ? `매일 ${saved}` : "꺼짐"} />
      </div>
      <RunSection data={data} active={active} saved={saved} reload={reload} />
      <LabelSection data={data} busy={Boolean(active)} reload={reload} onOpen={setOpen} />
      <EpisodeSection labels={data.labels} />
      <Section title="변경 이력">
        <p class="muted small-text">실행이 스스로 한 것과 사람이 한 것입니다. 줄을 누르면 바뀌기 전과 뒤, 자동 검토가 적은 이유가 펼쳐집니다.</p>
        <Revisions path="/mining/revisions" refresh={data} />
      </Section>
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
          refresh={data}
          running={active?.status === "running"}
          reload={reload}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** 기다리거나 실행 중인 실행: 어느 단계인지, 그 단계에서 얼마나 했는지, 지금까지의 수 */
function LiveRun(props: { run: NonNullable<Overview["active"]>; busy: boolean; onStop: () => void }) {
  const r = props.run;
  const now = Date.now();
  const stop = (
    <button class="small danger" disabled={props.busy || r.stopRequested} onClick={props.onStop}>
      {r.stopRequested ? "중지하는 중…" : "중지"}
    </button>
  );
  if (r.status === "requested") {
    const slow = now - Date.parse(r.requestedAt) > SLOW_START_MS;
    return (
      <div class="run-live">
        <div class="run-live-head">
          <strong role="status">시작 대기</strong>
          <span class="muted small-text">
            <Time at={r.requestedAt} /> 요청 · mining 서비스가 10초 안에 시작합니다
          </span>
          {stop}
        </div>
        <div class="meter busy" role="progressbar" aria-label="시작을 기다리는 중">
          <i />
        </div>
        {slow && <p class="warn-text small-text">1분 넘게 시작하지 않았습니다. mining 서비스가 떠 있는지 확인하세요 (docker compose ps mining).</p>}
      </div>
    );
  }
  const at = phaseOf(r.stage);
  const stage = r.stage ? STAGE[r.stage] : null;
  const total = r.stageTotal ?? 0;
  const done = r.stageDone ?? 0;
  const quiet = r.progressAt ? now - Date.parse(r.progressAt) : 0;
  return (
    <div class="run-live">
      <div class="run-live-head">
        <strong>실행 중</strong>
        <span class="muted small-text">
          {TRIGGER[r.trigger]} · {formatTime(r.startedAt).slice(11)} 시작 · {duration(now - Date.parse(r.startedAt!))} 지남 (길어야 3시간)
          {r.progressAt && (
            <>
              {" · "}
              <span class={quiet > STALLED_MS ? "warn-text" : ""}>마지막 진행 {quiet < 60_000 ? `${Math.round(quiet / 1000)}초 전` : timeAgo(r.progressAt)}</span>
            </>
          )}
        </span>
        {stop}
      </div>
      {r.stopRequested && <p class="warn-text small-text">중지를 요청했습니다. 보내 둔 LLM 호출이 끝나면 멈추고, 그때까지 읽은 것은 남습니다.</p>}
      {/* 이름만 다시 짓는 실행은 단계가 하나다 */}
      {r.trigger !== "rename" && (
        <ol class="phases">
          {PHASES.map((p, i) => (
            <li key={p.label} class={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
              {p.label}
            </li>
          ))}
        </ol>
      )}
      <div class="run-live-now">
        {/* 단계가 바뀔 때만 읽힌다 (수는 3초마다 바뀌므로 밖에 둔다) */}
        <span role="status">{stage ? stage.text : "gateway.db와 모델을 여는 중"}</span>
        {stage?.unit && total > 0 && (
          <b>
            {done.toLocaleString()} / {total.toLocaleString()} {stage.unit}
          </b>
        )}
      </div>
      <div
        class={total > 0 ? "meter" : "meter busy"}
        role="progressbar"
        aria-label={stage?.text ?? "준비 중"}
        aria-valuemin={0}
        aria-valuemax={total > 0 ? total : undefined}
        aria-valuenow={total > 0 ? done : undefined}
      >
        <i style={total > 0 ? { width: `${(done / total) * 100}%` } : undefined} />
      </div>
      {r.working.length > 0 && (
        <>
          <h3>지금 LLM에 보낸 것 {r.working.length}건</h3>
          <ul class="plain-list working">
            {r.working.map((w, i) =>
              w.kind === "session" ? (
                <li key={i}>
                  <span class="muted">세션 읽기</span> <span class="mono">{w.user ?? "-"}</span> <a class="mono muted" href={`#/history/${enc(w.sessionId)}`}>{w.sessionId}</a>
                </li>
              ) : (
                <li key={i}>
                  <span class="muted">{w.kind === "episode" ? "작업" : "프로세스"}</span> {w.text}
                </li>
              ),
            )}
          </ul>
        </>
      )}
      <dl class="run-live-counts">
        <Count label="읽은 세션" value={r.processed} />
        <Count label="읽지 못한 세션" value={r.failed} tone="err" />
        <Count label="남은 세션" value={r.remaining} />
        <Count label="뽑은 작업" value={r.episodes} />
        <Count label="프로세스 변경" value={r.changes} />
      </dl>
    </div>
  );
}

function Count(props: { label: string; value: number | null; tone?: "err" }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd class={props.tone && props.value ? `${props.tone}-text` : ""}>{props.value === null ? "-" : props.value.toLocaleString()}</dd>
    </div>
  );
}

/** 표의 수 칸. 0은 흐리게, tone을 주면 0이 아닐 때 그 색으로 */
function Num(props: { value: number | null; tone?: "warn" | "err" }) {
  const { value } = props;
  return <td class={`num ${value ? (props.tone ? `${props.tone}-text` : "") : "muted"}`}>{value === null ? "-" : value.toLocaleString()}</td>;
}

function RunSection(props: { data: Overview; active: Overview["active"] | undefined; saved: string; reload: () => Promise<void> }) {
  const { active, saved } = props;
  const { next } = props.data;
  const [time, setTime] = useState(saved);
  const action = useAction();

  const start = () =>
    action.run(async () => {
      await api("POST", "/mining/run");
      await props.reload();
    });
  const stop = () =>
    confirm(active?.status === "running" ? "실행을 중지할까요? 그때까지 읽은 것은 남고, 남은 세션은 다음 실행이 이어 갑니다." : "실행 요청을 취소할까요?") &&
    void action.run(async () => {
      await api("POST", "/mining/run/stop");
      await props.reload();
    });
  const save = (next: string) =>
    action.run(async () => {
      await api("PUT", "/mining/schedule", { dailyAt: next ? shiftTime(next, "utc") : null });
      setTime(next);
      await props.reload();
    }, next ? "저장했습니다." : "자동 실행을 껐습니다.");
  const [parallel, setParallel] = useState(String(props.data.concurrency));
  const nextParallel = /^\d+$/.test(parallel.trim()) && Number(parallel) >= 1 && Number(parallel) <= MAX_CONCURRENCY ? Number(parallel) : null;
  const saveParallel = () =>
    action.run(async () => {
      await api("PUT", "/mining/concurrency", { value: nextParallel });
      await props.reload();
    }, "저장했습니다. 다음 실행부터 적용됩니다.");
  // 고를 수 있는 모델은 채팅 화면과 같다 (티어와 모든 서버의 모델)
  const { data: llm } = useLoad<{ models: { id: string }[]; defaultModel: string | null }>("/chat/options");
  const { model } = props.data;
  const saveModel = (next: string) =>
    action.run(async () => {
      await api("PUT", "/mining/model", { model: next || null });
      await props.reload();
    }, "저장했습니다. 다음 실행부터 적용됩니다.");
  const { prompt } = props.data;
  const [editingPrompt, setEditingPrompt] = useState(false);
  // 개요를 다시 읽을 때마다 (실행 중에는 3초마다) 이력도 다시 읽는다
  const runs = usePaged<{ items: Run[]; total: number; pageSize: number }>("/mining/runs", props.data);

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
      {active ? (
        <LiveRun run={active} busy={action.busy} onStop={stop} />
      ) : (
        <p>
          {next.sessions + next.episodes === 0
            ? "읽을 새 세션은 없습니다 (마지막 활동 뒤 30분 넘게 쉰 세션만 읽습니다)."
            : `지금 실행하면 세션 ${next.sessions.toLocaleString()}개를 읽고, 뽑아 둔 작업 ${next.episodes.toLocaleString()}건과 새로 뽑는 작업을 프로세스로 분류합니다.`}
          {props.data.unlabeled30 >= 20 && ` 실행할 때마다 ${UNLABELED} ${props.data.unlabeled30.toLocaleString()}건에서 무작위로 60건씩 3번 뽑아 새 프로세스를 찾습니다.`}
        </p>
      )}
      <div class="row wrap">
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
        <span class="muted small-text">{saved ? "이 브라우저의 시간대" : "지금은 자동으로 실행하지 않습니다"}</span>
      </div>
      <div class="row wrap">
        <label for="mining-concurrency">LLM을 동시에</label>
        <input id="mining-concurrency" class="days mono" inputMode="numeric" value={parallel} onInput={(e) => setParallel(e.currentTarget.value)} />
        <span>개까지 부르기</span>
        <button disabled={action.busy || nextParallel === null || nextParallel === props.data.concurrency} onClick={() => void saveParallel()}>
          저장
        </button>
        <span class="muted small-text">
          1–{MAX_CONCURRENCY}. 세션 읽기·배정·대표 흐름을 이 수만큼 한꺼번에 합니다. 사용자 대화와 같은 LLM 서버를 쓰므로 서버가 받을 수 있는 만큼만 올립니다. 다음 실행부터 적용됩니다.
        </span>
      </div>
      <div class="row wrap">
        <label for="mining-model">모델</label>
        <select id="mining-model" value={model ?? ""} disabled={action.busy || !llm} onChange={(e) => void saveModel(e.currentTarget.value)}>
          <option value="">기본 모델{llm?.defaultModel ? ` (${llm.defaultModel})` : ""}</option>
          {model && llm && !llm.models.some((m) => m.id === model) && <option value={model}>{model} (LLM 설정에 없음)</option>}
          {llm?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <span class="muted small-text">작업을 뽑고 프로세스로 분류하는 데 쓰는 모델입니다. 다음 실행부터 적용됩니다.</span>
      </div>
      <div class="row wrap">
        <span>추가 프롬프트</span>
        <span class="muted">{prompt ? `${prompt.length.toLocaleString()}자` : "없음"}</span>
        <button onClick={() => setEditingPrompt(true)}>편집</button>
        <span class="muted small-text">세션 읽기·분류·검토·대표 흐름의 모든 호출에서 시스템 프롬프트 끝에 붙습니다. 다음 실행부터 적용됩니다.</span>
      </div>
      {editingPrompt && <PromptModal prompt={prompt ?? ""} reload={props.reload} onClose={() => setEditingPrompt(false)} />}
      <details>
        <summary>한 번 실행하면 하는 일</summary>
        <p class="muted small-text">
          마지막 활동이 30일 안이고 30분 넘게 쉰 세션 중 새 내용이 있는 것을 읽어 작업을 뽑고, 프로세스로 분류하고, 새 프로세스를 찾고, 근거가 쌓인 프로세스를 다시 검토해 고치거나 나눕니다.
          길어야 3시간 돌고, 못 읽은 세션은 다음 실행이 이어 갑니다.
        </p>
      </details>
      <h3>실행 이력</h3>
      {runs.error && <Notice tone="error">{runs.error}</Notice>}
      {runs.data && <Runs items={runs.data.items} />}
      {runs.pager}
    </Section>
  );
}

/** 추가 시스템 프롬프트를 고치는 창 */
function PromptModal(props: { prompt: string; reload: () => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(props.prompt);
  const action = useAction();
  const save = () =>
    action.run(async () => {
      await api("PUT", "/mining/prompt", { prompt: draft });
      await props.reload();
    }, "저장했습니다. 다음 실행부터 적용됩니다.");

  return (
    <Modal title="추가 프롬프트" onClose={props.onClose}>
      {action.view}
      <label class="field">
        <span>마이닝의 기본 지시 뒤에 붙일 글 (예: 조직의 용어, 프로세스 이름을 짓는 방식). 비우고 저장하면 없어집니다.</span>
        <textarea rows={12} value={draft} maxLength={PROMPT_CHARS} disabled={action.busy} onInput={(e) => setDraft(e.currentTarget.value)} />
      </label>
      <div class="row wrap">
        <button class="primary" disabled={action.busy || draft.trim() === props.prompt} onClick={() => void save()}>
          저장
        </button>
        <span class="muted small-text">
          {draft.length.toLocaleString()} / {PROMPT_CHARS.toLocaleString()}자
        </span>
      </div>
    </Modal>
  );
}

/** 실행 이력. 끝까지 가지 못한 실행에는 멈춘 단계가 나온다. */
function Runs(props: { items: Run[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>요청</th>
          <th>계기</th>
          <th>결과</th>
          <th class="num">걸린 시간</th>
          <th class="num">읽은 세션</th>
          <th class="num">읽지 못함</th>
          <th class="num">남음</th>
          <th class="num">작업</th>
          <th class="num">변경</th>
          <th>모델 · 실패 이유</th>
        </tr>
      </thead>
      <tbody>
        {props.items.length === 0 && <EmptyRow cols={10}>아직 실행한 적이 없습니다.</EmptyRow>}
        {props.items.map((r) => {
          const stopped = r.finishedAt !== null && r.status !== "completed" && phaseOf(r.stage) >= 0;
          return (
            <tr key={r.id}>
              <td>
                <Time at={r.requestedAt} />
              </td>
              <td>{TRIGGER[r.trigger]}</td>
              <td>
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Badge>
                {stopped && <span class="muted small-text"> {PHASES[phaseOf(r.stage)]!.label}에서</span>}
              </td>
              <td class="num">{r.startedAt ? duration((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt)) : "-"}</td>
              <Num value={r.processed} />
              <Num value={r.failed} tone="err" />
              <Num value={r.remaining} tone="warn" />
              <Num value={r.episodes} />
              <Num value={r.changes} />
              <td class={r.error ? "clip wrap err-text" : "clip mono muted"} title={r.error ? undefined : (r.model ?? undefined)}>
                {r.error ?? r.model ?? "-"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** busy: 요청됐거나 실행 중인 실행이 있다 */
function LabelSection(props: { data: Overview; busy: boolean; reload: () => Promise<void>; onOpen: (id: number | "none") => void }) {
  const { labels, unlabeled30 } = props.data;
  const sorted = [...labels].sort((a, b) => b.recent30 - a.recent30 || a.id - b.id);
  const most = Math.max(unlabeled30, ...labels.map((l) => l.recent30));
  const action = useAction();
  /** 이름을 다시 지을 프로세스 수: 사람이 고친 것은 건드리지 않는다 */
  const auto = labels.filter((l) => !l.editedAt).length;
  const rename = () =>
    confirm(`사람이 고치지 않은 프로세스 ${auto}개의 이름을 지금 모델과 추가 프롬프트로 다시 지을까요? 기준과 작업 분류는 그대로이고, 바뀐 이름은 변경 이력에 남습니다.`) &&
    void action.run(async () => {
      await api("POST", "/mining/rename");
      await props.reload();
    });
  return (
    <Section
      title="프로세스"
      actions={
        <>
          <span class="muted small-text">최근 30일 작업이 많은 순 · 줄을 누르면 기준·대표 흐름·작업이 열립니다</span>
          <button disabled={action.busy || props.busy || auto === 0} onClick={rename}>
            이름 다시 짓기
          </button>
        </>
      }
    >
      {action.view}
      <table class="table chart slim">
        <thead>
          <tr>
            <th>프로세스</th>
            <th>기준</th>
            <th colSpan={2}>30일</th>
            <th class="num">7일</th>
            <th class="num">전체</th>
            <th class="num">사용자</th>
            <th>생긴 때</th>
          </tr>
        </thead>
        <tbody>
          {labels.length === 0 && <EmptyRow cols={8}>아직 없습니다. 미분류 작업이 20건 이상 쌓이면 실행할 때 찾습니다.</EmptyRow>}
          {sorted.map((l) => (
            <tr key={l.id} {...rowAction(() => props.onOpen(l.id))}>
              <td>
                {l.name} {l.editedAt && <Badge title="사람이 이름·기준을 고쳤습니다. 자동 검토가 바꾸지 않습니다">사람이 고침</Badge>}
              </td>
              <td class="clip muted" title={l.criteria}>
                {l.criteria}
              </td>
              <Bar value={l.recent30} max={most} />
              <Num value={l.recent30} />
              <Num value={l.recent7} />
              <Num value={l.total} />
              <Num value={l.users} />
              <td>
                <Time at={l.createdAt} />
              </td>
            </tr>
          ))}
          <tr {...rowAction(() => props.onOpen("none"))}>
            <td class="muted">{UNLABELED}</td>
            <td class="clip muted">어느 프로세스에도 들지 않은 작업</td>
            <Bar value={unlabeled30} max={most} />
            <Num value={unlabeled30} />
            <td class="num muted">-</td>
            <td class="num muted">-</td>
            <td class="num muted">-</td>
            <td class="muted">-</td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

/** 프로세스 하나: 이름·기준 수정, 합치기, 지우기, 대표 흐름, 그 작업 */
function LabelModal(props: { label: Label; others: Label[]; refresh: unknown; running: boolean; reload: () => Promise<void>; onClose: () => void }) {
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
    }, "저장했습니다. 다음 실행부터 이 기준으로 작업을 분류하고, 자동 검토는 이 프로세스의 이름·기준을 바꾸지 않습니다.");
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
      <p class="muted small-text">
        최근 30일 {label.recent30.toLocaleString()}건 · 7일 {label.recent7.toLocaleString()}건 · 전체 {label.total.toLocaleString()}건 · 사용자 {label.users}명 · {formatTime(label.createdAt)}에 생김
        {label.editedAt && ` · 사람이 ${formatTime(label.editedAt)}에 고쳐, 자동 검토가 이름·기준을 바꾸지 않습니다`}
      </p>
      <label class="field">
        <span>이름</span>
        <input value={name} maxLength={60} disabled={locked} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>기준 (어떤 작업이 여기에 드는지. 실행할 때 모델이 이 글을 보고 작업을 분류합니다)</span>
        <textarea rows={3} value={criteria} maxLength={300} disabled={locked} onInput={(e) => setCriteria(e.currentTarget.value)} />
      </label>
      <div class="row wrap">
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
            confirm(`"${label.name}"을(를) 지울까요? 작업 ${label.total}건은 다음 실행이 다른 프로세스로 다시 분류해 봅니다.`) &&
            void remove(() => api("DELETE", `/mining/labels/${label.id}`))
          }
        >
          지우기
        </button>
      </div>
      <h3>대표 흐름</h3>
      {label.flow ? (
        <ol class="flow">
          {label.flow.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      ) : (
        <p class="muted">아직 없습니다. 실행할 때 씁니다.</p>
      )}
      <h3>변경 이력</h3>
      <Revisions path={`/mining/revisions?label=${label.id}`} refresh={props.refresh} />
      <h3>작업</h3>
      <Episodes path={`/mining/episodes?label=${label.id}`} />
    </Modal>
  );
}

/** 프로세스에 일어난 변경 (한 페이지씩). 줄을 누르면 바뀌기 전과 뒤, 자동 검토가 적은 이유가 펼쳐진다. */
function Revisions(props: { path: string; refresh: unknown }) {
  const { data, error, pager } = usePaged<{ items: Revision[]; total: number; pageSize: number }>(props.path, props.refresh);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p class="muted">불러오는 중…</p>;
  return (
    <>
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
        {data.items.length === 0 && <EmptyRow cols={5}>아직 변경이 없습니다.</EmptyRow>}
        {data.items.map((r) => (
          <Fragment key={r.id}>
            <tr {...rowAction(() => setOpen(open === r.id ? null : r.id))} class={open === r.id ? "clickable open" : "clickable"}>
              <td>
                <Time at={r.at} />
              </td>
              <td class={r.runId === null ? "" : "muted"}>{r.runId === null ? "사람" : "자동"}</td>
              <td>
                <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].text}</Badge>
              </td>
              <td>{r.name}</td>
              <td class="clip muted">{r.reason ?? revisionText(r)}</td>
            </tr>
            {open === r.id && (
              <tr>
                <td colSpan={5} class="wrap detail">
                  <dl class="pairs">
                    {r.before && (
                      <>
                        <dt>{r.kind === "created" ? "나뉘기 전" : "전"}</dt>
                        <dd>{r.before}</dd>
                      </>
                    )}
                    {r.after && (
                      <>
                        <dt>{r.kind === "merged" ? "합쳐진 곳" : r.kind === "split" ? "나뉜 것" : "뒤"}</dt>
                        <dd>{r.after}</dd>
                      </>
                    )}
                    {r.reason && (
                      <>
                        <dt>이유</dt>
                        <dd>{r.reason}</dd>
                      </>
                    )}
                    <dt>때</dt>
                    <dd>
                      {formatTime(r.at)} · {r.runId === null ? "사람이 관리 화면에서" : "자동 실행이"}
                    </dd>
                  </dl>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
    {pager}
    </>
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
      {/* 조건이 바뀌면 첫 페이지부터 */}
      <Episodes key={path} path={path} labels={props.labels} />
    </Section>
  );
}

interface EpisodePage {
  items: Episode[];
  /** 조건에 맞는 작업 전부의 수와, 그 프로세스별 수 (많은 순. labelId가 null이면 미분류) */
  total: number;
  pageSize: number;
  counts: { labelId: number | null; count: number }[];
}

/** 작업 목록 (한 페이지씩). 줄을 누르면 단계와 그 대화로 가는 링크가 펼쳐진다. labels를 주면 프로세스 칸과 프로세스별 건수를 보여 준다. */
function Episodes(props: { path: string; labels?: Label[] }) {
  const { data, error, pager } = usePaged<EpisodePage>(props.path);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p class="muted">불러오는 중…</p>;

  const names = new Map(props.labels?.map((l) => [l.id, l.name]));
  const nameOf = (labelId: number | null) => (labelId === null ? UNLABELED : (names.get(labelId) ?? UNLABELED));
  const cols = props.labels ? 4 : 3;
  return (
    <>
      {props.labels && data.counts.length > 0 && (
        <p class="muted small-text">
          {data.counts.slice(0, 5).map((c) => `${nameOf(c.labelId)} ${c.count.toLocaleString()}건`).join(", ")}
          {data.counts.length > 5 && ` 외 ${data.counts.length - 5}개 프로세스`}
        </p>
      )}
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
              <tr {...rowAction(() => setOpen(open === e.id ? null : e.id))} class={open === e.id ? "clickable open" : "clickable"}>
                <td>
                  <Time at={e.endedAt} />
                </td>
                <td class="mono">{e.user ?? "-"}</td>
                {props.labels && <td class={e.labelId === null ? "muted" : ""}>{nameOf(e.labelId)}</td>}
                <td class="clip">{e.goal}</td>
              </tr>
              {open === e.id && (
                <tr>
                  <td colSpan={cols} class="wrap detail">
                    <p>{e.goal}</p>
                    <ol class="flow">
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
      {pager}
    </>
  );
}
