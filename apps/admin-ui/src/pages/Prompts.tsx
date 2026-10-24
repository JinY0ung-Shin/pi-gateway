import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText, formatTime } from "../api";
import { Badge, Notice, Section, useAction } from "../components";
import type { PromptDeployment, PromptDetail, PromptList, SessionPreview } from "../types";

type Selection = { kind: "default" } | { kind: "prompt"; name: string } | { kind: "new" } | { kind: "full" };

export function PromptsPage() {
  const [list, setList] = useState<PromptList | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "default" });
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setList(await api<PromptList>("GET", "/prompts"));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  if (loadError) return <Notice tone="error">{loadError}</Notice>;
  if (!list) return <p class="muted">불러오는 중…</p>;

  return (
    <div class="split">
      <aside class="sidebar card">
        <div class="sidebar-head">
          <strong>프롬프트</strong>
          <button class="small" onClick={() => setSelection({ kind: "new" })}>
            + 새 프롬프트
          </button>
        </div>
        <ul class="nav-list">
          <li>
            <button class={selection.kind === "default" ? "active" : ""} onClick={() => setSelection({ kind: "default" })}>
              기본 프롬프트 {list.live.isDefault && <Badge tone="green">배포 중</Badge>}
            </button>
          </li>
          {list.prompts.map((p) => (
            <li key={p.name}>
              <button
                class={selection.kind === "prompt" && selection.name === p.name ? "active" : ""}
                onClick={() => setSelection({ kind: "prompt", name: p.name })}
              >
                <span class="mono">{p.name}</span> <span class="muted">v{p.latestVersion}</span>
                {p.liveVersion !== null && <Badge tone="green">v{p.liveVersion} 배포 중</Badge>}
              </button>
            </li>
          ))}
        </ul>
        <ul class="nav-list">
          <li>
            <button class={selection.kind === "full" ? "active" : ""} onClick={() => setSelection({ kind: "full" })}>
              모델이 받는 전체 프롬프트
            </button>
          </li>
        </ul>
        <p class="muted small-text">변수: {list.variables.map((v) => `{{${v}}}`).join(" ")}</p>
      </aside>
      <div class="main">
        {selection.kind === "default" && <DefaultPrompt list={list} onChanged={reload} />}
        {selection.kind === "full" && <FullPrompt />}
        {selection.kind === "new" && (
          <NewPrompt
            onCreated={async (name) => {
              await reload();
              setSelection({ kind: "prompt", name });
            }}
          />
        )}
        {selection.kind === "prompt" && (
          <PromptEditor
            key={selection.name}
            name={selection.name}
            list={list}
            onChanged={reload}
          />
        )}
        <Deployments revision={list.live.revision} />
      </div>
    </div>
  );
}

function DefaultPrompt(props: { list: PromptList; onChanged: () => Promise<void> }) {
  const action = useAction();
  const [preview, setPreview] = useState<string | null>(null);
  const { live } = props.list;
  return (
    <Section
      title="기본 프롬프트"
      actions={
        <>
          <button
            onClick={() => action.run(async () => setPreview((await api<{ text: string }>("POST", "/prompt-render", { content: props.list.defaultContent })).text))}
          >
            미리보기
          </button>
          {!live.isDefault && (
            <button
              class="danger"
              disabled={action.busy}
              onClick={() =>
                confirm("배포를 취소하고 기본 프롬프트로 되돌릴까요? 새 세션부터 적용됩니다.") &&
                action.run(async () => {
                  await api("POST", "/prompt-live/reset", {});
                  await props.onChanged();
                }, "기본 프롬프트로 되돌렸습니다")
              }
            >
              기본 프롬프트로 되돌리기
            </button>
          )}
        </>
      }
    >
      {action.view}
      <p class="muted">
        배포된 프롬프트가 없을 때 쓰는 gateway 내장 프롬프트입니다. 현재 배포:{" "}
        {live.isDefault ? <Badge tone="green">기본 프롬프트</Badge> : <Badge tone="blue">{`${live.name} v${live.version}`}</Badge>} ({formatTime(live.deployedAt)},{" "}
        {live.deployedBy})
      </p>
      <pre class="code-block">{props.list.defaultContent}</pre>
      {preview !== null && (
        <>
          <h3>렌더링 결과</h3>
          <pre class="code-block">{preview}</pre>
        </>
      )}
    </Section>
  );
}

/** 배포 중인 프롬프트로 새 세션을 열었을 때 모델이 실제로 받는 시스템 프롬프트와 도구 */
function FullPrompt() {
  const action = useAction();
  const [user, setUser] = useState("admin");
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const load = () => action.run(async () => setPreview(await api<SessionPreview>("POST", "/chat/preview", { user })));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Section
      title="모델이 받는 전체 프롬프트"
      actions={
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <input class="mono" aria-label="user" value={user} onInput={(e) => setUser(e.currentTarget.value)} />
          <button type="submit" disabled={action.busy || !user}>
            {action.busy ? "여는 중…" : "다시 보기"}
          </button>
        </form>
      }
    >
      {action.view}
      <p class="muted">
        이 user로 새 대화를 열면 기본 모델이 받는 내용입니다. 배포 중인 프롬프트 뒤에 사용자 이름·skill 목록·작업 디렉토리가 붙고, 도구는 MCP 서버에서 받은 것까지 따로 실립니다.
      </p>
      {preview && (
        <>
          <h3>
            시스템 프롬프트 · <span class="mono">{preview.model}</span> · {preview.systemPrompt.length.toLocaleString()}자
          </h3>
          <pre class="code-block">{preview.systemPrompt}</pre>
          <h3>도구 {preview.tools.length}개</h3>
          <div class="tool-list">
            {preview.tools.map((t) => (
              <details key={t.name}>
                <summary>
                  <span class="mono">{t.name}</span> <span class="muted">{t.description.split("\n")[0]}</span>
                </summary>
                <pre class="code-block">{t.description}</pre>
                <pre class="code-block mono">{JSON.stringify(t.parameters, null, 2)}</pre>
              </details>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function NewPrompt(props: { onCreated: (name: string) => Promise<void> }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  return (
    <Section title="새 프롬프트">
      {action.view}
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api("POST", "/prompts", { name, description, content, message: "처음 만듦" });
            await props.onCreated(name);
          });
        }}
      >
        <label class="field">
          <span>이름 (영문·숫자·_·-)</span>
          <input value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,63}" required />
        </label>
        <label class="field">
          <span>설명</span>
          <input value={description} onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)} maxLength={500} />
        </label>
        <label class="field">
          <span>내용</span>
          <textarea rows={18} class="mono" value={content} onInput={(e) => setContent((e.currentTarget as HTMLTextAreaElement).value)} required />
        </label>
        <button class="primary" type="submit" disabled={action.busy}>
          만들기
        </button>
      </form>
    </Section>
  );
}

function PromptEditor(props: { name: string; list: PromptList; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [preview, setPreview] = useState<{ text: string; unknown: string[] } | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const action = useAction();
  const live = props.list.live;

  const load = async () => {
    const d = await api<PromptDetail>("GET", `/prompts/${enc(props.name)}`);
    setDetail(d);
    setDraft(d.versions.at(-1)?.content ?? "");
  };
  useEffect(() => {
    void action.run(load);
  }, [props.name]);

  if (!detail) return action.view ?? <p class="muted">불러오는 중…</p>;
  const latest = detail.versions.at(-1)!;
  const shownVersion = shown === null ? null : detail.versions.find((v) => v.version === shown);

  const saveVersion = () =>
    action.run(async () => {
      await api("POST", `/prompts/${enc(props.name)}/versions`, { content: draft, message });
      setMessage("");
      await load();
      await props.onChanged();
    }, "새 버전을 저장했습니다");

  const deploy = (version: number) => {
    const rollback = live.name === props.name && live.version !== null && version < live.version;
    if (!confirm(`${props.name} v${version}을 ${rollback ? "롤백 배포" : "배포"}할까요? 새 세션부터 적용됩니다.`)) return;
    void action.run(async () => {
      await api("POST", `/prompts/${enc(props.name)}/deploy`, { version });
      await props.onChanged();
      await load();
    }, `v${version}을 배포했습니다`);
  };

  return (
    <Section
      title={props.name}
      actions={detail.liveVersion !== null && <Badge tone="green">v{detail.liveVersion} 배포 중</Badge>}
    >
      {action.view}
      <p class="muted">{detail.description || "설명 없음"}</p>
      <div class="tabs">
        <button class={view === "edit" ? "active" : ""} onClick={() => setView("edit")}>
          편집
        </button>
        <button
          class={view === "preview" ? "active" : ""}
          onClick={() => {
            setView("preview");
            void action.run(async () => setPreview(await api<{ text: string; unknown: string[] }>("POST", "/prompt-render", { content: draft })));
          }}
        >
          미리보기
        </button>
      </div>
      {view === "edit" && (
        <div class="form">
          <textarea rows={20} class="mono" value={draft} onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)} />
          <div class="row">
            <input
              class="grow"
              placeholder="변경 내용 (선택)"
              value={message}
              maxLength={200}
              onInput={(e) => setMessage((e.currentTarget as HTMLInputElement).value)}
            />
            <button class="primary" disabled={action.busy || draft === latest.content} onClick={saveVersion}>
              v{latest.version + 1}로 저장
            </button>
          </div>
        </div>
      )}
      {view === "preview" && preview && (
        <>
          {preview.unknown.length > 0 && <Notice tone="warn">알 수 없는 변수는 그대로 남습니다: {preview.unknown.join(", ")}</Notice>}
          <pre class="code-block">{preview.text}</pre>
        </>
      )}
      <h3>버전</h3>
      <table class="table">
        <thead>
          <tr>
            <th>버전</th>
            <th>메시지</th>
            <th>작성자</th>
            <th>시각</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...detail.versions].reverse().map((v) => (
            <tr key={v.version}>
              <td>
                v{v.version} {detail.liveVersion === v.version && <Badge tone="green">배포 중</Badge>}
              </td>
              <td>{v.message || <span class="muted">-</span>}</td>
              <td>{v.author}</td>
              <td>{formatTime(v.createdAt)}</td>
              <td class="actions">
                <button class="small" onClick={() => setShown(shown === v.version ? null : v.version)}>
                  {shown === v.version ? "닫기" : "보기"}
                </button>
                <button class="small" disabled={detail.liveVersion === v.version || action.busy} onClick={() => deploy(v.version)}>
                  {live.name === props.name && live.version !== null && v.version < live.version ? "롤백" : "배포"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shownVersion && <pre class="code-block">{shownVersion.content}</pre>}
    </Section>
  );
}

function Deployments(props: { revision: string }) {
  const [items, setItems] = useState<PromptDeployment[]>([]);
  useEffect(() => {
    api<{ deployments: PromptDeployment[] }>("GET", "/prompt-deployments?limit=30")
      .then((r) => setItems(r.deployments))
      .catch(() => setItems([]));
  }, [props.revision]);
  if (items.length === 0) return null;
  const label = { deploy: "배포", rollback: "롤백", reset: "기본으로" } as const;
  return (
    <Section title="배포 이력">
      <table class="table">
        <thead>
          <tr>
            <th>시각</th>
            <th>동작</th>
            <th>배포본</th>
            <th>이전</th>
            <th>작업자</th>
            <th>메모</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>{formatTime(d.at)}</td>
              <td>
                <Badge tone={d.action === "rollback" ? "amber" : d.action === "reset" ? "gray" : "blue"}>{label[d.action]}</Badge>
              </td>
              <td>{d.name ? `${d.name} v${d.version}` : "기본 프롬프트"}</td>
              <td class="muted">{d.fromName ? `${d.fromName} v${d.fromVersion}` : "기본 프롬프트"}</td>
              <td>{d.actor}</td>
              <td>{d.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
