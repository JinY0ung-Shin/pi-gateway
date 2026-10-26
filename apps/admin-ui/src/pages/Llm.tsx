import { useEffect, useState } from "preact/hooks";
import { api, errorText, formatTime } from "../api";
import { Badge, linesToRecord, Modal, Notice, recordToLines, Section, useAction } from "../components";

/**
 * LLM 연결 설정. 서버마다 주소·키·모델을 두고, 저장하면 바로 적용된다 (진행 중인 턴은 끝난 뒤, 다음 턴부터).
 * 연결 확인·모델 가져오기·모델 테스트는 화면에 입력한 값으로 하므로 저장하기 전에 해 볼 수 있다.
 */

type ApiKind = "openai-completions" | "anthropic-messages";

interface ModelRow {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

interface ServerView {
  id: string;
  api: ApiKind;
  baseUrl: string;
  headers: Record<string, string>;
  compat: Record<string, unknown>;
  models: ModelRow[];
  apiKeySet: boolean;
}

interface LlmView {
  configured: boolean;
  settings: { servers: ServerView[]; defaultModel: string } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  models?: { id: string; name?: string; contextWindow?: number }[];
}

interface TestResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  text?: string;
  thinking?: boolean;
  stopReason?: string;
  usage?: { input: number; output: number };
}

/** 화면에서 고치는 서버. saved면 gateway에 저장된 서버라 id를 바꿀 수 없고, 키 칸을 비워 두면 저장된 키를 쓴다. */
interface ServerForm {
  key: string;
  saved: boolean;
  apiKeySet: boolean;
  id: string;
  api: ApiKind;
  baseUrl: string;
  headers: string;
  compat: string;
  apiKey: string;
  clearKey: boolean;
  models: ModelRow[];
}

const BASE_URL: Record<ApiKind, { placeholder: string; hint: string }> = {
  "openai-completions": { placeholder: "http://vllm.internal:8000/v1", hint: "/v1까지 넣습니다. 뒤에 /chat/completions, /models를 붙여 부릅니다." },
  "anthropic-messages": { placeholder: "http://vllm.internal:8000", hint: "/v1 없이 넣습니다. 뒤에 /v1/messages, /v1/models를 붙여 부릅니다." },
};

let lastKey = 0;
const newKey = () => `server-${++lastKey}`;

function toForm(s: ServerView): ServerForm {
  return {
    key: newKey(),
    saved: true,
    apiKeySet: s.apiKeySet,
    id: s.id,
    api: s.api,
    baseUrl: s.baseUrl,
    headers: recordToLines(s.headers, ": "),
    compat: Object.keys(s.compat).length ? JSON.stringify(s.compat, null, 2) : "",
    apiKey: "",
    clearKey: false,
    models: s.models,
  };
}

const emptyServer = (id: string): ServerForm => ({
  key: newKey(),
  saved: false,
  apiKeySet: false,
  id,
  api: "openai-completions",
  baseUrl: "",
  headers: "",
  compat: "",
  apiKey: "",
  clearKey: false,
  models: [],
});

/** 연결 확인에 쓰는 값. apiKey를 빼면 gateway가 같은 id로 저장된 키를 쓴다. */
function connectionOf(s: ServerForm) {
  return {
    id: s.id.trim(),
    api: s.api,
    baseUrl: s.baseUrl.trim(),
    headers: linesToRecord(s.headers, ":"),
    ...(s.clearKey ? { apiKey: "" } : s.apiKey ? { apiKey: s.apiKey } : {}),
  };
}

function toBody(s: ServerForm) {
  let compat: Record<string, unknown> = {};
  if (s.compat.trim()) {
    try {
      compat = JSON.parse(s.compat) as Record<string, unknown>;
    } catch {
      throw new Error(`${s.id || "새 서버"}: compat이 JSON 객체가 아닙니다.`);
    }
  }
  return {
    ...connectionOf(s),
    compat,
    models: s.models.map((m) => ({ ...m, id: m.id.trim(), name: m.name?.trim() || undefined })),
  };
}

/** 저장 안 한 변경이 있는지 보는 값 */
const snapshot = (servers: ServerForm[], defaultModel: string) =>
  JSON.stringify([servers.map(({ key: _k, saved: _s, apiKeySet: _a, ...rest }) => rest), defaultModel]);

/** 오류 메시지의 `servers.0.models.1.` 같은 경로를 서버·모델 id로 바꾼다 */
function readablePaths(message: string, servers: ServerForm[]): string {
  const sid = (i: string) => servers[Number(i)]?.id || `서버 ${Number(i) + 1}`;
  return message
    .replace(/servers\.(\d+)\.models\.(\d+)\./g, (_, i: string, j: string) => `${sid(i)} › ${servers[Number(i)]?.models[Number(j)]?.id || `모델 ${Number(j) + 1}`} › `)
    .replace(/servers\.(\d+)\./g, (_, i: string) => `${sid(i)} › `);
}

/** 서버가 알려 준 contextWindow로 정하는 maxTokens 기본값 */
const defaultMaxTokens = (contextWindow: number) => Math.max(256, Math.min(8192, Math.floor(contextWindow / 4)));

export function LlmPage() {
  const [view, setView] = useState<LlmView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerForm[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [probes, setProbes] = useState<Record<string, ProbeResult | "checking">>({});
  const action = useAction();

  const probe = async (s: ServerForm): Promise<ProbeResult> => {
    setProbes((p) => ({ ...p, [s.key]: "checking" }));
    let result: ProbeResult;
    try {
      result = await api<ProbeResult>("POST", "/llm/probe", { server: connectionOf(s) });
    } catch (error) {
      result = { ok: false, durationMs: 0, error: errorText(error) };
    }
    setProbes((p) => ({ ...p, [s.key]: result }));
    return result;
  };

  const show = (v: LlmView) => {
    const forms = v.settings ? v.settings.servers.map(toForm) : [emptyServer("default")];
    const dm = v.settings?.defaultModel ?? "";
    setView(v);
    setServers(forms);
    setDefaultModel(dm);
    setSavedSnapshot(snapshot(forms, dm));
    setProbes({});
    for (const s of forms) if (s.saved) void probe(s);
  };

  useEffect(() => {
    api<LlmView>("GET", "/llm")
      .then(show)
      .catch((error) => setLoadError(errorText(error)));
  }, []);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!view) return <p class="muted">불러오는 중…</p>;

  const dirty = snapshot(servers, defaultModel) !== savedSnapshot;
  const modelCount = servers.reduce((n, s) => n + s.models.length, 0);

  const change = (key: string, patch: Partial<ServerForm>) => {
    setServers((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    // 연결 값이 바뀌면 이전 확인 결과는 맞지 않는다
    if (["api", "baseUrl", "headers", "apiKey", "clearKey"].some((k) => k in patch)) {
      setProbes(({ [key]: _, ...rest }) => rest);
    }
  };

  const remove = (s: ServerForm) => {
    const rest = servers.filter((x) => x.key !== s.key);
    setServers(rest);
    if (s.models.some((m) => m.id === defaultModel)) setDefaultModel(rest.flatMap((x) => x.models)[0]?.id ?? "");
  };

  const addServer = () => {
    const ids = new Set(servers.map((s) => s.id));
    let n = servers.length + 1;
    while (ids.has(`server-${n}`)) n++;
    setServers([...servers, emptyServer(servers.length === 0 ? "default" : `server-${n}`)]);
  };

  const save = () =>
    action.run(async () => {
      if (servers.length === 0) throw new Error("LLM 서버를 하나 이상 추가하세요.");
      const empty = servers.find((s) => s.models.length === 0);
      if (empty) throw new Error(`서버 ${empty.id || "(id 없음)"}에 모델이 없습니다. 모델을 추가하거나 서버를 빼세요.`);
      const dm = defaultModel.trim();
      if (!servers.some((s) => s.models.some((m) => m.id.trim() === dm))) throw new Error("기본 모델을 고르세요 (모델 표의 '기본' 칸).");
      const body = { servers: servers.map(toBody), defaultModel: dm };
      try {
        show(await api<LlmView>("PUT", "/llm", body));
      } catch (error) {
        throw new Error(readablePaths(error instanceof Error ? error.message : String(error), servers));
      }
    }, "저장했습니다. 새 턴부터 적용됩니다.");

  return (
    <>
      {!view.configured && <Notice tone="warn">LLM이 설정되지 않았습니다. 설정하기 전에는 /v1/responses가 503을 돌려줍니다.</Notice>}
      <p class="muted small-text">
        서버 {servers.length}대 · 모델 {modelCount}개 · 기본 모델 <span class="mono">{defaultModel || "없음"}</span>
        {view.updatedAt && ` · 마지막 저장 ${formatTime(view.updatedAt)} (${view.updatedBy})`}
      </p>
      {servers.map((s) => (
        <ServerCard
          key={s.key}
          server={s}
          others={servers.filter((x) => x.key !== s.key)}
          defaultModel={defaultModel}
          probe={probes[s.key]}
          onChange={(patch) => change(s.key, patch)}
          onDefault={setDefaultModel}
          onProbe={() => probe(s)}
          onRemove={() => remove(s)}
        />
      ))}
      <button onClick={addServer}>+ 서버 추가</button>
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

function ServerCard(props: {
  server: ServerForm;
  others: ServerForm[];
  defaultModel: string;
  probe: ProbeResult | "checking" | undefined;
  onChange: (patch: Partial<ServerForm>) => void;
  onDefault: (id: string) => void;
  onProbe: () => Promise<ProbeResult>;
  onRemove: () => void;
}) {
  const s = props.server;
  const [picking, setPicking] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult | "testing">>({});
  const [lastTest, setLastTest] = useState<{ model: string; result: TestResult } | null>(null);
  const checking = props.probe === "checking";
  const probe = props.probe === "checking" ? undefined : props.probe;
  const listed = probe?.ok ? new Set(probe.models?.map((m) => m.id)) : null;
  const missing = listed ? s.models.filter((m) => m.id && !listed.has(m.id)) : [];
  const canConnect = s.baseUrl.trim() !== "";
  const hint = BASE_URL[s.api];

  const setModel = (i: number, patch: Partial<ModelRow>) => {
    const before = s.models[i]!;
    props.onChange({ models: s.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
    // 기본 모델의 id를 바꾸면 기본 모델도 따라간다
    if (patch.id !== undefined && before.id !== "" && before.id === props.defaultModel) props.onDefault(patch.id);
  };

  const removeModel = (i: number) => {
    const gone = s.models[i]!;
    props.onChange({ models: s.models.filter((_, j) => j !== i) });
    if (gone.id === props.defaultModel) props.onDefault("");
  };

  const addModels = (rows: ModelRow[]) => {
    props.onChange({ models: [...s.models, ...rows] });
    if (!props.defaultModel && rows[0]) props.onDefault(rows[0].id);
    setPicking(false);
  };

  const fetchModels = async () => {
    if ((await props.onProbe()).ok) setPicking(true);
  };

  const test = async (m: ModelRow) => {
    setTests((t) => ({ ...t, [m.id]: "testing" }));
    let result: TestResult;
    try {
      result = await api<TestResult>("POST", "/llm/test", { server: toBody(s), model: m.id.trim() });
    } catch (error) {
      result = { ok: false, durationMs: 0, error: errorText(error) };
    }
    setTests((t) => ({ ...t, [m.id]: result }));
    setLastTest({ model: m.id, result });
  };

  /** 다른 서버에 이미 있는 모델 id → 그 서버 id */
  const taken = new Map<string, string>([
    ...props.others.flatMap((o) => o.models.map((m) => [m.id, o.id || "다른 서버"] as [string, string])),
    ...s.models.map((m) => [m.id, ""] as [string, string]),
  ]);

  return (
    <Section
      title={`서버 ${s.id || "(id 없음)"}`}
      actions={
        <>
          <button disabled={!canConnect || checking} onClick={() => void props.onProbe()}>
            {checking ? "확인 중…" : "연결 확인"}
          </button>
          <button disabled={!canConnect || checking} onClick={() => void fetchModels()}>
            모델 가져오기
          </button>
          <button class="danger" onClick={props.onRemove}>
            서버 빼기
          </button>
        </>
      }
    >
      <ConnectionStatus checking={checking} probe={probe} missing={missing.length} saved={s.saved} />
      <div class="grid-2">
        <label class="field">
          <span>서버 id {s.saved ? "(저장한 뒤에는 바꿀 수 없습니다)" : "(영문 소문자·숫자·_·-)"}</span>
          <input class="mono" value={s.id} disabled={s.saved} placeholder="vllm-a" onInput={(e) => props.onChange({ id: e.currentTarget.value })} />
        </label>
        <label class="field">
          <span>API 형식</span>
          <select value={s.api} onChange={(e) => props.onChange({ api: e.currentTarget.value as ApiKind })}>
            <option value="openai-completions">openai-completions (/v1/chat/completions)</option>
            <option value="anthropic-messages">anthropic-messages (/v1/messages)</option>
          </select>
        </label>
        <label class="field">
          <span>base URL</span>
          <input class="mono" value={s.baseUrl} placeholder={hint.placeholder} onInput={(e) => props.onChange({ baseUrl: e.currentTarget.value })} />
          <small class="muted">{hint.hint}</small>
        </label>
        <div class="field">
          <label class="field-label" for={`${s.key}-key`}>
            API 키 {s.apiKeySet ? <Badge tone="green">저장됨</Badge> : <Badge>없음</Badge>}
          </label>
          <input
            id={`${s.key}-key`}
            type="password"
            class="mono"
            autocomplete="off"
            value={s.apiKey}
            disabled={s.clearKey}
            placeholder={s.apiKeySet ? "바꿀 때만 입력 (비우면 저장된 키를 씁니다)" : "키가 없는 엔드포인트면 비워 둡니다"}
            onInput={(e) => props.onChange({ apiKey: e.currentTarget.value })}
          />
          {s.apiKeySet && (
            <label class="checkbox">
              <input type="checkbox" checked={s.clearKey} onChange={(e) => props.onChange({ clearKey: e.currentTarget.checked })} />
              <span>저장된 키 지우기</span>
            </label>
          )}
        </div>
      </div>
      <details open={Boolean(s.headers || s.compat)}>
        <summary class="muted small-text">요청 헤더 · compat</summary>
        <div class="grid-2">
          <label class="field">
            <span>요청 헤더 (한 줄에 하나, 이름: 값)</span>
            <textarea class="mono" rows={3} value={s.headers} placeholder="X-Team: ai" onInput={(e) => props.onChange({ headers: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>compat (JSON, 선택. openai-completions면 vLLM 기본값 위에 합칩니다)</span>
            <textarea class="mono" rows={3} value={s.compat} placeholder='{"thinkingFormat":"qwen"}' onInput={(e) => props.onChange({ compat: e.currentTarget.value })} />
          </label>
        </div>
      </details>

      {picking && probe?.ok && <ModelPicker available={probe.models ?? []} taken={taken} onAdd={addModels} onClose={() => setPicking(false)} />}

      <h3>모델</h3>
      {lastTest && (
        <Notice tone={lastTest.result.ok ? "ok" : "error"} onClose={() => setLastTest(null)}>
          <TestSummary model={lastTest.model} result={lastTest.result} />
        </Notice>
      )}
      <table class="table compact">
        <thead>
          <tr>
            <th>기본</th>
            <th>id</th>
            <th>표시 이름</th>
            <th>contextWindow</th>
            <th>maxTokens</th>
            <th title="답하기 전에 생각(reasoning)하는 모델">reasoning</th>
            <th title="이미지 입력을 받는 모델">이미지</th>
            <th>상태</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {s.models.length === 0 && (
            <tr>
              <td colSpan={9} class="muted">
                모델이 없습니다. '모델 가져오기'로 서버의 모델을 고르거나 직접 추가하세요.
              </td>
            </tr>
          )}
          {s.models.map((m, i) => {
            const t = tests[m.id];
            return (
              <tr key={i}>
                <td>
                  <input
                    type="radio"
                    name="default-model"
                    aria-label={`${m.id} 기본 모델`}
                    checked={m.id !== "" && m.id === props.defaultModel}
                    onChange={() => props.onDefault(m.id)}
                  />
                </td>
                <td>
                  <input class="mono" value={m.id} placeholder="Qwen/Qwen3-32B" onInput={(e) => setModel(i, { id: e.currentTarget.value })} />
                </td>
                <td>
                  <input value={m.name ?? ""} placeholder={m.id} onInput={(e) => setModel(i, { name: e.currentTarget.value })} />
                </td>
                <td>
                  <input type="number" min={1} value={m.contextWindow} onInput={(e) => setModel(i, { contextWindow: Number(e.currentTarget.value) })} />
                </td>
                <td>
                  <input type="number" min={1} value={m.maxTokens} onInput={(e) => setModel(i, { maxTokens: Number(e.currentTarget.value) })} />
                </td>
                <td>
                  <input type="checkbox" checked={m.reasoning} onChange={(e) => setModel(i, { reasoning: e.currentTarget.checked })} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={m.input.includes("image")}
                    onChange={(e) => setModel(i, { input: e.currentTarget.checked ? ["text", "image"] : ["text"] })}
                  />
                </td>
                <td>
                  {listed && m.id && (listed.has(m.id) ? <Badge tone="green">서버에 있음</Badge> : <Badge tone="amber" title="서버의 /models 목록에 이 id가 없습니다">서버에 없음</Badge>)}
                  {t === "testing" && <Badge>테스트 중…</Badge>}
                  {t && t !== "testing" && (t.ok ? <Badge tone="green">{`응답 ${duration(t.durationMs)}`}</Badge> : <Badge tone="red">응답 실패</Badge>)}
                </td>
                <td class="actions">
                  <button class="small" disabled={!canConnect || !m.id.trim() || t === "testing"} onClick={() => void test(m)}>
                    테스트
                  </button>
                  <button class="small danger" onClick={() => removeModel(i)}>
                    빼기
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div class="row">
        <button class="small" onClick={() => addModels([{ id: "", contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text"] }])}>
          + 직접 추가
        </button>
        <span class="muted small-text">contextWindow는 vLLM의 --max-model-len과 맞춥니다. 뺀 모델로 만든 세션은 이어갈 수 없습니다.</span>
      </div>
    </Section>
  );
}

function ConnectionStatus(props: { checking: boolean; probe: ProbeResult | undefined; missing: number; saved: boolean }) {
  if (props.checking) return <p class="muted small-text">연결 확인 중…</p>;
  const { probe } = props;
  if (!probe) {
    return <p class="muted small-text">{props.saved ? "연결 값이 바뀌었습니다. '연결 확인'을 눌러 다시 확인하세요." : "'연결 확인'이나 '모델 가져오기'로 서버에 연결되는지 확인하세요."}</p>;
  }
  if (!probe.ok) return <Notice tone="error">연결 실패: {probe.error}</Notice>;
  return (
    <p class="small-text">
      <Badge tone="green">연결됨</Badge> <span class="muted">{`${probe.durationMs}ms · 서버의 모델 ${probe.models?.length ?? 0}개`}</span>
      {props.missing > 0 && <Badge tone="amber">{`서버에 없는 모델 ${props.missing}개`}</Badge>}
    </p>
  );
}

function ModelPicker(props: {
  available: NonNullable<ProbeResult["models"]>;
  /** 이미 등록된 모델 id → 그 서버 id ("" = 이 서버) */
  taken: Map<string, string>;
  onAdd: (rows: ModelRow[]) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string, on: boolean) => setPicked(on ? [...picked, id] : picked.filter((x) => x !== id));
  const add = () =>
    props.onAdd(
      props.available
        .filter((m) => picked.includes(m.id))
        .map((m) => {
          const contextWindow = m.contextWindow ?? 32768;
          return { id: m.id, ...(m.name ? { name: m.name } : {}), contextWindow, maxTokens: defaultMaxTokens(contextWindow), reasoning: false, input: ["text"] };
        }),
    );
  return (
    <Modal title={`서버에 있는 모델 ${props.available.length}개`} onClose={props.onClose}>
      {props.available.length === 0 ? (
        <p class="muted small-text">서버가 모델 목록을 주지 않았습니다. 모델 표의 '+ 직접 추가'로 넣으세요.</p>
      ) : (
        <table class="table compact">
          <thead>
            <tr>
              <th />
              <th>id</th>
              <th>contextWindow</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.available.map((m) => {
              const where = props.taken.get(m.id);
              return (
                <tr key={m.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={m.id}
                      disabled={where !== undefined}
                      checked={picked.includes(m.id)}
                      onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                    />
                  </td>
                  <td class="mono">
                    {m.id} {m.name && <span class="muted">{m.name}</span>}
                  </td>
                  <td>{m.contextWindow ? m.contextWindow.toLocaleString() : <span class="muted">알 수 없음 (32,768로 넣습니다)</span>}</td>
                  <td>{where !== undefined && <Badge>{where === "" ? "추가됨" : `${where}에 있음`}</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div class="row">
        <button class="primary small" disabled={picked.length === 0} onClick={add}>
          {`선택한 ${picked.length}개 추가`}
        </button>
        <span class="muted small-text">reasoning·이미지 여부는 서버가 알려 주지 않으니 추가한 뒤 표시하세요.</span>
      </div>
    </Modal>
  );
}

const duration = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`);

function TestSummary(props: { model: string; result: TestResult }) {
  const { model, result: r } = props;
  if (!r.ok) {
    return (
      <>
        <span class="mono">{model}</span> 응답 실패: {r.error}
      </>
    );
  }
  const notes = [
    r.thinking && "생각(reasoning) 포함",
    r.stopReason === "length" && "길이 제한에서 멈춤",
    r.usage && `토큰 입력 ${r.usage.input} · 출력 ${r.usage.output}`,
  ].filter(Boolean);
  return (
    <>
      <span class="mono">{model}</span> {duration(r.durationMs)} 만에 응답했습니다{r.text ? `: "${r.text}"` : " (답 텍스트 없음)"}
      {notes.length > 0 && <div class="small-text">{notes.join(" · ")}</div>}
    </>
  );
}
