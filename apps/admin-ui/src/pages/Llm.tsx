import { useEffect, useState } from "preact/hooks";
import { api, errorText, formatTime } from "../api";
import { Badge, linesToRecord, Notice, recordToLines, Section, useAction } from "../components";

/** LLM 연결 설정. 저장하면 바로 적용된다 (진행 중인 턴은 끝난 뒤, 다음 턴부터). */

interface ModelRow {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

interface LlmSettingsView {
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  headers: Record<string, string>;
  compat: Record<string, unknown>;
  models: ModelRow[];
  defaultModel: string;
}

interface LlmView {
  configured: boolean;
  settings: LlmSettingsView | null;
  apiKeySet: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

const EMPTY: LlmSettingsView = {
  api: "openai-completions",
  baseUrl: "",
  headers: {},
  compat: {},
  models: [{ id: "", contextWindow: 32768, maxTokens: 8192, reasoning: false, input: ["text"] }],
  defaultModel: "",
};

export function LlmPage() {
  const [view, setView] = useState<LlmView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<LlmSettingsView>(EMPTY);
  const [headers, setHeaders] = useState("");
  const [compat, setCompat] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const action = useAction();

  const show = (v: LlmView) => {
    setView(v);
    const s = v.settings ?? EMPTY;
    setForm(s);
    setHeaders(recordToLines(s.headers, ": "));
    setCompat(Object.keys(s.compat).length ? JSON.stringify(s.compat, null, 2) : "");
    setApiKey("");
    setClearKey(false);
  };

  useEffect(() => {
    api<LlmView>("GET", "/llm")
      .then(show)
      .catch((error) => setLoadError(errorText(error)));
  }, []);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!view) return <p class="muted">불러오는 중…</p>;

  const set = (patch: Partial<LlmSettingsView>) => setForm({ ...form, ...patch });
  const setModel = (i: number, patch: Partial<ModelRow>) => {
    const models = form.models.map((m, j) => (j === i ? { ...m, ...patch } : m));
    // 기본 모델의 id를 바꾸면 기본 모델도 따라간다
    const defaultModel = patch.id !== undefined && form.models[i]!.id === form.defaultModel ? patch.id : form.defaultModel;
    set({ models, defaultModel });
  };
  const removeModel = (i: number) => set({ models: form.models.filter((_, j) => j !== i) });
  const addModel = () => set({ models: [...form.models, { ...EMPTY.models[0]! }] });

  const save = () =>
    action.run(async () => {
      let compatValue: Record<string, unknown> = {};
      if (compat.trim()) {
        try {
          compatValue = JSON.parse(compat) as Record<string, unknown>;
        } catch {
          throw new Error("compat이 JSON 객체가 아닙니다.");
        }
      }
      const body: Record<string, unknown> = {
        ...form,
        baseUrl: form.baseUrl.trim(),
        models: form.models.map((m) => ({ ...m, id: m.id.trim(), name: m.name?.trim() || undefined })),
        headers: linesToRecord(headers, ":"),
        compat: compatValue,
      };
      // apiKey를 빼면 지금 키를 유지한다
      if (clearKey) body.apiKey = "";
      else if (apiKey) body.apiKey = apiKey;
      const next = await api<LlmView>("PUT", "/llm", body);
      show(next);
      return next;
    }, "저장했습니다. 새 턴부터 적용됩니다.");

  return (
    <>
      {!view.configured && <Notice tone="warn">LLM이 설정되지 않았습니다. 설정하기 전에는 /v1/responses가 503을 돌려줍니다.</Notice>}
      {action.view}
      <Section
        title="LLM 연결"
        actions={
          view.updatedAt && (
            <span class="muted small-text">
              {formatTime(view.updatedAt)} · {view.updatedBy}
            </span>
          )
        }
      >
        <div class="grid-2">
          <label class="field">
            <span>API 형식</span>
            <select value={form.api} onChange={(e) => set({ api: e.currentTarget.value as LlmSettingsView["api"] })}>
              <option value="openai-completions">openai-completions (/v1/chat/completions)</option>
              <option value="anthropic-messages">anthropic-messages (/v1/messages)</option>
            </select>
          </label>
          <label class="field">
            <span>base URL</span>
            <input class="mono" value={form.baseUrl} placeholder="http://vllm.internal:8000/v1" onInput={(e) => set({ baseUrl: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span>
              API 키 {view.apiKeySet ? <Badge tone="green">설정됨</Badge> : <Badge>없음</Badge>}
            </span>
            <input
              type="password"
              class="mono"
              autocomplete="off"
              value={apiKey}
              disabled={clearKey}
              placeholder={view.apiKeySet ? "바꿀 때만 입력 (비우면 지금 키 유지)" : "키가 없는 엔드포인트면 비워 둡니다"}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
          </label>
          {view.apiKeySet && (
            <label class="checkbox">
              <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.currentTarget.checked)} />
              <span>키 지우기</span>
            </label>
          )}
        </div>
        <div class="grid-2">
          <label class="field">
            <span>요청 헤더 (한 줄에 하나, 이름: 값)</span>
            <textarea class="mono" rows={3} value={headers} placeholder="X-Team: ai" onInput={(e) => setHeaders(e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>compat (JSON, 선택. openai-completions면 vLLM 기본값 위에 합칩니다)</span>
            <textarea class="mono" rows={3} value={compat} placeholder='{"thinkingFormat":"qwen"}' onInput={(e) => setCompat(e.currentTarget.value)} />
          </label>
        </div>
      </Section>

      <Section title="모델" actions={<button onClick={addModel}>+ 모델 추가</button>}>
        <table class="table compact">
          <thead>
            <tr>
              <th>기본</th>
              <th>id</th>
              <th>표시 이름</th>
              <th>contextWindow</th>
              <th>maxTokens</th>
              <th>reasoning</th>
              <th>이미지</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.models.map((m, i) => (
              <tr key={i}>
                <td>
                  <input type="radio" name="default-model" checked={m.id !== "" && m.id === form.defaultModel} onChange={() => set({ defaultModel: m.id })} />
                </td>
                <td>
                  <input class="mono" value={m.id} placeholder="Qwen/Qwen3-32B" onInput={(e) => setModel(i, { id: e.currentTarget.value })} />
                </td>
                <td>
                  <input value={m.name ?? ""} onInput={(e) => setModel(i, { name: e.currentTarget.value })} />
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
                <td class="actions">
                  <button class="small danger" disabled={form.models.length === 1} onClick={() => removeModel(i)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="muted small-text">contextWindow는 vLLM의 --max-model-len과 맞춥니다. 지운 모델로 만든 세션은 이어갈 수 없습니다.</p>
      </Section>

      <div class="row">
        <button class="primary" disabled={action.busy} onClick={() => void save()}>
          저장
        </button>
        <button disabled={action.busy} onClick={() => view && show(view)}>
          되돌리기
        </button>
      </div>
    </>
  );
}
