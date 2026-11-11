import { useEffect, useState } from "preact/hooks";
import { api, errorText, formatTime } from "../api";
import { ApiKeyField, Badge, linesToRecord, Modal, Notice, recordToLines, Section, useAction, useLoad } from "../components";

/**
 * System One 설정. mcp_search가 도구를 고를 때 묻는 decision model 서버 하나를 둔다. 저장하면 다음 검색부터 적용된다.
 * 모델 가져오기·테스트는 화면에 입력한 값으로 하므로 저장하기 전에 해 볼 수 있다. base URL과 모델 id를 모두 비우고 저장하면 쓰지 않는다.
 * 최근 요청은 mcp_search가 실제로 보낸 요청이다 (gateway 메모리에만 있다).
 */

interface SystemOneView {
  model: { baseUrl: string; id: string; headers: Record<string, string>; compare: boolean; apiKeySet: boolean } | null;
  updatedAt: string | null;
}

interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  models?: { id: string; name?: string }[];
}

/** System One 요청 하나: 테스트 결과와 최근 요청이 같은 모양이다 */
interface Call {
  at: string;
  durationMs: number;
  /** `/systemone`으로 보낸 요청 본문 */
  request?: unknown;
  /** 받은 답. 실패했으면 없다. */
  answer?: { choice: string; probabilities: Record<string, number>; confidence: number };
  error?: string;
}

/** 화면에서 고치는 값. 키 칸을 비워 두면 저장된 키를 쓴다. */
interface Form {
  apiKeySet: boolean;
  baseUrl: string;
  id: string;
  headers: string;
  apiKey: string;
  clearKey: boolean;
  /** 검색의 절반은 BM25로 찾는다 (정확도 비교용) */
  compare: boolean;
}

const toForm = (v: SystemOneView): Form => ({
  apiKeySet: v.model?.apiKeySet ?? false,
  baseUrl: v.model?.baseUrl ?? "",
  id: v.model?.id ?? "",
  headers: recordToLines(v.model?.headers, ": "),
  apiKey: "",
  clearKey: false,
  compare: v.model?.compare ?? false,
});

/** 연결에 쓰는 값. apiKey를 빼면 gateway가 저장된 키를 쓴다. */
const connectionOf = (f: Form) => ({
  baseUrl: f.baseUrl.trim(),
  headers: linesToRecord(f.headers, ":"),
  ...(f.clearKey ? { apiKey: "" } : f.apiKey ? { apiKey: f.apiKey } : {}),
});

/** 요청 본문의 model. base URL과 모델 id가 모두 비면 null (쓰지 않음). */
function toBody(f: Form) {
  const id = f.id.trim();
  if (!f.baseUrl.trim() && !id) return null;
  if (!f.baseUrl.trim() || !id) throw new Error("base URL과 모델 id를 모두 넣으세요. 쓰지 않으려면 둘 다 비웁니다.");
  return { ...connectionOf(f), id, compare: f.compare };
}

/** 저장 안 한 변경이 있는지 보는 값 */
const snapshot = ({ apiKeySet: _, ...rest }: Form) => JSON.stringify(rest);

export function SystemOnePage() {
  const { data: loaded, error: loadError } = useLoad<SystemOneView>("/systemone");
  const [view, setView] = useState<SystemOneView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<Call | "testing" | null>(null);
  const [probe, setProbe] = useState<ProbeResult | "checking" | null>(null);
  const action = useAction();

  const show = (v: SystemOneView) => {
    setView(v);
    setForm(toForm(v));
    setTest(null);
    setProbe(null);
  };

  useEffect(() => {
    if (loaded) show(loaded);
  }, [loaded]);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!view || !form) return <p class="muted">불러오는 중…</p>;

  const dirty = snapshot(form) !== snapshot(toForm(view));
  const filled = form.baseUrl.trim() !== "" && form.id.trim() !== "";

  // 값이 바뀌면 이전 테스트 결과는 맞지 않는다
  const change = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };

  const fetchModels = async () => {
    setProbe("checking");
    try {
      setProbe(await api<ProbeResult>("POST", "/systemone/probe", { model: connectionOf(form) }));
    } catch (error) {
      setProbe({ ok: false, durationMs: 0, error: errorText(error) });
    }
  };

  const runTest = async () => {
    setTest("testing");
    try {
      setTest(await api<Call>("POST", "/systemone/test", { model: toBody(form) }));
    } catch (error) {
      setTest({ at: new Date().toISOString(), durationMs: 0, error: errorText(error) });
    }
  };

  const save = () =>
    action.run(async () => show(await api<SystemOneView>("PUT", "/systemone", { model: toBody(form) })), "저장했습니다. 다음 검색부터 적용됩니다.");

  return (
    <>
      {!view.model && <Notice tone="info">System One을 쓰지 않습니다. mcp_search는 BM25(단어 일치)로 도구를 찾습니다.</Notice>}
      <p class="muted small-text">
        mcp_search가 모든 MCP 도구를 선택지로 주고 질의에 맞는 도구를 고르게 합니다. 호출이 실패하거나 10초를 넘은 검색은 BM25로 찾습니다.
        {view.updatedAt && ` · 마지막 저장 ${formatTime(view.updatedAt)}`}
      </p>
      <Section
        title="decision model 서버"
        actions={
          <>
            <button disabled={form.baseUrl.trim() === "" || probe === "checking"} onClick={() => void fetchModels()}>
              {probe === "checking" ? "가져오는 중…" : "모델 가져오기"}
            </button>
            <button disabled={!filled || test === "testing"} onClick={() => void runTest()}>
              {test === "testing" ? "테스트 중…" : "테스트"}
            </button>
          </>
        }
      >
        {probe && probe !== "checking" && !probe.ok && (
          <Notice tone="error" onClose={() => setProbe(null)}>
            연결 실패: {probe.error}
          </Notice>
        )}
        {probe && probe !== "checking" && probe.ok && (
          <ModelPicker
            models={probe.models ?? []}
            current={form.id.trim()}
            onPick={(id) => {
              change({ id });
              setProbe(null);
            }}
            onClose={() => setProbe(null)}
          />
        )}
        {test && test !== "testing" && (
          <CallDetail call={test} onClose={() => setTest(null)} />
        )}
        <div class="grid-2">
          <label class="field">
            <span>base URL</span>
            <input class="mono" value={form.baseUrl} placeholder="http://vllm-decision.internal:8000/v1" onInput={(e) => change({ baseUrl: e.currentTarget.value })} />
            <small class="muted">/v1까지 넣습니다. 뒤에 /systemone을 붙여 부릅니다 (vLLM 0.32.0 이상).</small>
          </label>
          <label class="field">
            <span>모델 id</span>
            <input class="mono" value={form.id} placeholder="vllm-sr/d3-ultra" onInput={(e) => change({ id: e.currentTarget.value })} />
          </label>
          <ApiKeyField id="systemone-key" value={form} onChange={change} />
          <label class="field">
            <span>요청 헤더 (한 줄에 하나, 이름: 값)</span>
            <textarea class="mono" rows={3} value={form.headers} placeholder="X-Team: ai" onInput={(e) => change({ headers: e.currentTarget.value })} />
          </label>
        </div>
        <label class="checkbox">
          <input type="checkbox" checked={form.compare} onChange={(e) => change({ compare: e.currentTarget.checked })} />
          <span>BM25와 비교: 검색의 절반은 무작위로 BM25로 찾습니다</span>
        </label>
        <p class="muted small-text">
          켜 두면 상태 페이지의 MCP 검색 정확도에 System One과 BM25의 top-1~3 비율이 같은 기간·같은 사용자 기준으로 쌓입니다. 비교가 끝나면 끕니다.
        </p>
      </Section>
      <RecentCalls />
      <div class={dirty ? "save-bar dirty" : "save-bar"}>
        {action.view}
        <div class="row wrap">
          <button class="primary" disabled={action.busy || !dirty} onClick={() => void save()}>
            저장
          </button>
          <button disabled={action.busy || !dirty} onClick={() => show(view)}>
            되돌리기
          </button>
          {dirty ? <span class="warn-text small-text">저장하지 않은 변경이 있습니다.</span> : <span class="muted small-text">바뀐 것이 없습니다.</span>}
        </div>
      </div>
    </>
  );
}

/** 서버의 `/models` 목록에서 모델 하나를 고른다 */
function ModelPicker(props: { models: NonNullable<ProbeResult["models"]>; current: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Modal title={`서버에 있는 모델 ${props.models.length}개`} onClose={props.onClose}>
      {props.models.length === 0 ? (
        <p class="muted small-text">서버가 모델 목록을 주지 않았습니다. 모델 id를 직접 넣으세요.</p>
      ) : (
        <table class="table compact">
          <tbody>
            {props.models.map((m) => (
              <tr key={m.id}>
                <td class="mono">
                  {m.id} {m.name && <span class="muted">{m.name}</span>}
                </td>
                <td class="actions">
                  <button class="small" disabled={m.id === props.current} onClick={() => props.onPick(m.id)}>
                    {m.id === props.current ? "선택됨" : "선택"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** 요청 하나의 결과와, `/systemone`으로 보낸 본문·받은 답 */
function CallDetail(props: { call: Call; onClose?: () => void }) {
  const { call } = props;
  return (
    <>
      <Notice tone={call.answer ? "ok" : "error"} onClose={props.onClose}>
        {call.answer ? `${call.durationMs}ms 만에 응답했습니다: ${call.answer.choice}` : `응답 실패: ${call.error}`}
      </Notice>
      <div class="grid-2">
        {call.request !== undefined && (
          <div class="field">
            <span>보낸 요청 본문</span>
            <pre class="code-block mono">{JSON.stringify(call.request, null, 2)}</pre>
          </div>
        )}
        {call.answer && (
          <div class="field">
            <span>받은 답</span>
            <pre class="code-block mono">{JSON.stringify(call.answer, null, 2)}</pre>
          </div>
        )}
      </div>
    </>
  );
}

/** 요청의 state를 한 줄로. mcp_search는 `{ query }`를 보낸다. */
function stateText(request: unknown): string {
  const state = (request as { state?: Record<string, unknown> } | undefined)?.state;
  if (!state) return "";
  return typeof state.query === "string" ? state.query : JSON.stringify(state);
}

function RecentCalls() {
  const { data, error, reload } = useLoad<{ items: Call[] }>("/systemone/calls");
  const [open, setOpen] = useState<Call | null>(null);
  const items = data?.items ?? [];
  return (
    <Section title="최근 요청" actions={<button onClick={() => void reload()}>새로고침</button>}>
      <p class="muted small-text">
        mcp_search가 System One에 실제로 보낸 요청 최근 20건입니다. gateway 메모리에만 있어서 다시 시작하면 비워집니다. 테스트 버튼으로 보낸 요청은 들어가지 않습니다.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <table class="table compact">
        <thead>
          <tr>
            <th>시각</th>
            <th>검색어</th>
            <th>고른 도구</th>
            <th class="num">걸린 시간</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={5} class="muted">
                아직 보낸 요청이 없습니다.
              </td>
            </tr>
          )}
          {items.map((c) => (
            <tr key={c.at}>
              <td>{formatTime(c.at)}</td>
              <td>{stateText(c.request)}</td>
              <td class="mono">{c.answer ? c.answer.choice : <Badge tone="red">실패</Badge>}</td>
              <td class="num">{c.durationMs}ms</td>
              <td class="actions">
                <button class="small" onClick={() => setOpen(c)}>
                  보기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <Modal title={`${formatTime(open.at)} 요청`} onClose={() => setOpen(null)}>
          <CallDetail call={open} />
        </Modal>
      )}
    </Section>
  );
}
