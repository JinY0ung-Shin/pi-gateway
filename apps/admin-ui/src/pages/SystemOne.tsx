import { useEffect, useState } from "preact/hooks";
import { api, errorText, formatTime } from "../api";
import { ApiKeyField, linesToRecord, Notice, recordToLines, Section, useAction, useLoad } from "../components";

/**
 * System One 설정. mcp_search가 도구를 고를 때 묻는 decision model 서버 하나를 둔다. 저장하면 다음 검색부터 적용된다.
 * 테스트는 화면에 입력한 값으로 하므로 저장하기 전에 해 볼 수 있다. base URL과 모델 id를 모두 비우고 저장하면 쓰지 않는다.
 */

interface SystemOneView {
  model: { baseUrl: string; id: string; headers: Record<string, string>; apiKeySet: boolean } | null;
  updatedAt: string | null;
}

interface TestResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  probabilities?: Record<string, number>;
}

/** 화면에서 고치는 값. 키 칸을 비워 두면 저장된 키를 쓴다. */
interface Form {
  apiKeySet: boolean;
  baseUrl: string;
  id: string;
  headers: string;
  apiKey: string;
  clearKey: boolean;
}

const toForm = (v: SystemOneView): Form => ({
  apiKeySet: v.model?.apiKeySet ?? false,
  baseUrl: v.model?.baseUrl ?? "",
  id: v.model?.id ?? "",
  headers: recordToLines(v.model?.headers, ": "),
  apiKey: "",
  clearKey: false,
});

/** 요청 본문의 model. base URL과 모델 id가 모두 비면 null (쓰지 않음). apiKey를 빼면 gateway가 저장된 키를 쓴다. */
function toBody(f: Form) {
  const baseUrl = f.baseUrl.trim();
  const id = f.id.trim();
  if (!baseUrl && !id) return null;
  if (!baseUrl || !id) throw new Error("base URL과 모델 id를 모두 넣으세요. 쓰지 않으려면 둘 다 비웁니다.");
  return { baseUrl, id, headers: linesToRecord(f.headers, ":"), ...(f.clearKey ? { apiKey: "" } : f.apiKey ? { apiKey: f.apiKey } : {}) };
}

/** 저장 안 한 변경이 있는지 보는 값 */
const snapshot = ({ apiKeySet: _, ...rest }: Form) => JSON.stringify(rest);

export function SystemOnePage() {
  const { data: loaded, error: loadError } = useLoad<SystemOneView>("/systemone");
  const [view, setView] = useState<SystemOneView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<TestResult | "testing" | null>(null);
  const action = useAction();

  const show = (v: SystemOneView) => {
    setView(v);
    setForm(toForm(v));
    setTest(null);
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

  const runTest = async () => {
    setTest("testing");
    try {
      setTest(await api<TestResult>("POST", "/systemone/test", { model: toBody(form) }));
    } catch (error) {
      setTest({ ok: false, durationMs: 0, error: errorText(error) });
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
          <button disabled={!filled || test === "testing"} onClick={() => void runTest()}>
            {test === "testing" ? "테스트 중…" : "테스트"}
          </button>
        }
      >
        {test && test !== "testing" && (
          <Notice tone={test.ok ? "ok" : "error"} onClose={() => setTest(null)}>
            {test.ok ? (
              <>
                {test.durationMs}ms 만에 응답했습니다
                {test.probabilities &&
                  ` (${Object.entries(test.probabilities)
                    .map(([option, p]) => `${option} ${(p * 100).toFixed(1)}%`)
                    .join(" · ")})`}
              </>
            ) : (
              <>응답 실패: {test.error}</>
            )}
          </Notice>
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
      </Section>
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
