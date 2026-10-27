import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText, formatTime } from "../api";
import { Badge, linesToRecord, Modal, Notice, recordToLines, RunsInBadge, Section, useAction } from "../components";
import type { McpScope, McpServerConfig, McpServerEntry, McpServerList, ToolSummary } from "../types";

/** 연결 확인 결과. broker 서버는 실제로 연결해 도구 목록을 받고, sandbox 서버는 설정과 파일만 본다. */
interface TestResult {
  ok: boolean;
  error?: string;
  note?: string;
  tools?: ToolSummary[];
  durationMs: number;
}

async function testServer(id: string): Promise<TestResult> {
  try {
    return await api<TestResult>("POST", `/mcp/servers/${enc(id)}/test`, {});
  } catch (error) {
    return { ok: false, error: errorText(error), durationMs: 0 };
  }
}

/** items를 limit개씩 동시에 처리한다 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function McpPage(props: { focus?: string | undefined }) {
  const [list, setList] = useState<McpServerList | null>(null);
  const [editing, setEditing] = useState<McpServerEntry | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, TestResult | "checking">>({});
  const [checkingAll, setCheckingAll] = useState(false);

  const reload = async () => {
    try {
      const next = await api<McpServerList>("GET", "/mcp/servers");
      setList(next);
      setError(null);
      return next;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  };
  useEffect(() => {
    void reload().then((next) => {
      const focus = next?.servers.find((s) => s.config.id === props.focus);
      if (focus) setEditing(focus);
    });
  }, [props.focus]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!list) return <p class="muted">불러오는 중…</p>;

  const setCheck = (id: string, result: TestResult | "checking" | null) =>
    setChecks(({ [id]: _, ...rest }) => (result ? { ...rest, [id]: result } : rest));

  const test = async (id: string) => {
    setCheck(id, "checking");
    setCheck(id, await testServer(id));
  };

  const checkAll = async () => {
    const targets = list.servers.filter((s) => s.config.enabled);
    setCheckingAll(true);
    setChecks(Object.fromEntries(targets.map((s) => [s.config.id, "checking" as const])));
    await eachLimit(targets, 4, async (s) => setCheck(s.config.id, await testServer(s.config.id)));
    setCheckingAll(false);
  };

  return (
    <>
      <Section
        title="MCP 서버"
        actions={
          <>
            <button disabled={checkingAll || !list.servers.some((s) => s.config.enabled)} onClick={() => void checkAll()}>
              {checkingAll ? "확인 중…" : "전체 연결 확인"}
            </button>
            <button class="primary" onClick={() => setEditing("new")}>
              + 서버 추가
            </button>
          </>
        }
      >
        <p class="muted">
          <RunsInBadge value="sandbox" /> 비밀키 없이 사용자 sandbox 안에서 실행 · <RunsInBadge value="broker" /> 비밀키를 가진 격리된 broker가 원격 HTTP 서버로 프록시
        </p>
        <p class="muted small-text">
          전체 연결 확인은 켜진 서버를 모두 확인합니다. broker 서버는 실제로 연결해 도구 목록을 받고, sandbox 서버는 세션에서 처음 쓸 때 시작하므로 설정과 파일만 확인합니다.
        </p>
        {!list.broker.available && <Notice tone="error">broker에 연결할 수 없습니다: {list.broker.error}</Notice>}
        <table class="table">
          <thead>
            <tr>
              <th>id</th>
              <th>실행</th>
              <th>대상</th>
              <th>범위</th>
              <th>출처</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.servers.length === 0 && (
              <tr>
                <td colSpan={7} class="muted">
                  등록된 서버가 없습니다.
                </td>
              </tr>
            )}
            {list.servers.map((s) => (
              <tr key={s.config.id} class="clickable" onClick={() => setEditing(s)}>
                <td>
                  <span class="mono">{s.config.id}</span>
                  {s.config.displayName && <div class="muted small-text">{s.config.displayName}</div>}
                </td>
                <td>
                  <RunsInBadge value={s.config.runIn} />
                </td>
                <td class="mono small-text">{s.config.transport.type === "stdio" ? `${s.config.transport.command} ${s.config.transport.args.join(" ")}` : s.config.transport.url}</td>
                <td>{s.config.scope}</td>
                <td>{s.config.source.kind === "plugin" ? <Badge tone="blue">{s.config.source.pluginId}</Badge> : <span class="muted">직접 등록</span>}</td>
                <td>
                  <ServerState entry={s} check={checks[s.config.id]} />
                </td>
                {/* 이 칸을 눌러도 편집 창은 열리지 않는다 */}
                <td class="actions" onClick={(e) => e.stopPropagation()}>
                  <button class="small" disabled={checks[s.config.id] === "checking"} onClick={() => void test(s.config.id)}>
                    테스트
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {editing && (
        <ServerEditor
          key={editing === "new" ? "new" : editing.config.id}
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            // 설정이 바뀌었으니 이전 확인 결과는 버린다
            if (id) setCheck(id, null);
            const next = await reload();
            const fresh = next?.servers.find((s) => s.config.id === id);
            setEditing(fresh ?? null);
          }}
        />
      )}
    </>
  );
}

/** 편집 창에서 env·args·url·headers에 쓰는 자리표시자 */
function Placeholders() {
  return (
    <details>
      <summary class="muted small-text">템플릿 자리표시자</summary>
      <table class="table compact">
        <tbody>
          <tr>
            <td class="mono">{"{{secret:NAME}}"}</td>
            <td>broker 비밀 저장소 값 (broker 서버만)</td>
          </tr>
          <tr>
            <td class="mono">{"{{ctx.header:NAME}}"}</td>
            <td>클라이언트 요청 헤더 (broker 서버만)</td>
          </tr>
          <tr>
            <td class="mono">{"{{user}}"}</td>
            <td>사용자 id (sandbox 서버는 per-user 이상)</td>
          </tr>
          <tr>
            <td class="mono">{"{{session}} · {{metadata:KEY}}"}</td>
            <td>세션 id · 요청 metadata (MCP_METADATA_KEYS 허용분, sandbox 서버는 per-session)</td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}

/** 목록의 상태 칸: 설정 문제, 연결 확인 결과, broker가 기억하는 최근 오류 */
function ServerState(props: { entry: McpServerEntry; check: TestResult | "checking" | undefined }) {
  const { entry, check } = props;
  const missing = entry.missingSecrets?.length ?? 0;
  const lastError = entry.status?.lastError;
  return (
    <>
      {!entry.config.enabled && <Badge>꺼짐</Badge>}
      {missing > 0 && <Badge tone="amber">비밀키 {missing}개 없음</Badge>}
      {check === "checking" && <Badge>확인 중…</Badge>}
      {check && check !== "checking" && check.ok && entry.store === "broker" && (
        <Badge tone="green">{`연결됨 · 도구 ${check.tools?.length ?? 0}개 · ${check.durationMs}ms`}</Badge>
      )}
      {check && check !== "checking" && check.ok && entry.store === "sandbox" && (
        <Badge tone="blue" title={check.note}>
          설정 확인됨
        </Badge>
      )}
      {check && check !== "checking" && !check.ok && (
        <>
          <Badge tone="red">{entry.store === "sandbox" ? "설정 오류" : "연결 실패"}</Badge>
          <div class="small-text err-text">{clip(check.error ?? "")}</div>
        </>
      )}
      {!check && entry.config.enabled && missing === 0 && <span class="muted small-text">확인 전</span>}
      {lastError && (
        <div class="small-text err-text" title={lastError}>
          최근 오류 {formatTime(entry.status?.lastErrorAt)}: {clip(lastError)}
        </div>
      )}
    </>
  );
}

const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);

interface FormState {
  id: string;
  displayName: string;
  description: string;
  enabled: boolean;
  runIn: "broker" | "sandbox";
  scope: McpScope;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  toolAllow: string;
  toolDeny: string;
  timeoutSec: number;
}

function toForm(config: McpServerConfig | null): FormState {
  const t = config?.transport;
  return {
    id: config?.id ?? "",
    displayName: config?.displayName ?? "",
    description: config?.description ?? "",
    enabled: config?.enabled ?? true,
    runIn: config?.runIn ?? "broker",
    scope: config?.scope ?? "shared",
    command: t?.type === "stdio" ? t.command : "",
    args: t?.type === "stdio" ? t.args.join("\n") : "",
    env: t?.type === "stdio" ? recordToLines(t.env) : "",
    cwd: t?.type === "stdio" ? (t.cwd ?? "") : "",
    url: t?.type === "http" ? t.url : "",
    headers: t?.type === "http" ? recordToLines(t.headers, ": ") : "",
    toolAllow: config?.toolAllow?.join(", ") ?? "",
    toolDeny: config?.toolDeny?.join(", ") ?? "",
    timeoutSec: config?.timeoutSec ?? 120,
  };
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** sandbox 서버는 stdio, broker 서버는 streamable HTTP다. */
function fromForm(f: FormState, source: McpServerConfig["source"]): McpServerConfig {
  const transport: McpServerConfig["transport"] =
    f.runIn === "sandbox"
      ? {
          type: "stdio",
          command: f.command.trim(),
          args: f.args.split("\n").map((a) => a.trim()).filter(Boolean),
          env: linesToRecord(f.env),
          ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}),
        }
      : { type: "http", url: f.url.trim(), headers: linesToRecord(f.headers, ":") };
  return {
    id: f.id.trim(),
    ...(f.displayName.trim() ? { displayName: f.displayName.trim() } : {}),
    ...(f.description.trim() ? { description: f.description.trim() } : {}),
    enabled: f.enabled,
    runIn: f.runIn,
    scope: f.scope,
    transport,
    ...(list(f.toolAllow).length ? { toolAllow: list(f.toolAllow) } : {}),
    ...(list(f.toolDeny).length ? { toolDeny: list(f.toolDeny) } : {}),
    timeoutSec: Number(f.timeoutSec) || 120,
    source,
  };
}

function ServerEditor(props: { entry: McpServerEntry | null; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [form, setForm] = useState<FormState>(() => toForm(props.entry?.config ?? null));
  const [errors, setErrors] = useState<string[]>([]);
  const [required, setRequired] = useState<string[]>(props.entry?.requiredSecrets ?? []);
  const action = useAction();
  const isNew = props.entry === null;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const source = props.entry?.config.source ?? { kind: "manual" as const };

  /** 서버 검증. clearsSecrets는 이대로 저장하면 broker가 지울 비밀키다. */
  const validate = async () => {
    const result = await api<{ ok: boolean; errors: string[]; requiredSecrets: string[]; clearsSecrets: string[] }>("POST", "/mcp/validate", {
      config: fromForm(form, source),
    });
    setErrors(result.errors);
    setRequired(result.requiredSecrets);
    return result;
  };

  const save = () =>
    action.run(
      async () => {
        const { ok, clearsSecrets: cleared } = await validate();
        if (!ok) throw new Error("설정을 고쳐 주세요");
        const config = fromForm(form, source);
        if (cleared.length > 0) {
          const yes = confirm(
            `이 변경은 서버의 실행 대상(URL 주소·헤더)이나 실행 위치를 바꿉니다.\n` +
              `저장하면 broker가 저장된 비밀키 ${cleared.join(", ")}를 지우므로, 저장한 뒤 다시 입력해야 합니다.\n계속할까요?`,
          );
          if (!yes) return { cancelled: true, cleared: [] as string[] };
        }
        await api("PUT", `/mcp/servers/${enc(config.id)}`, { config });
        await props.onSaved(config.id);
        return { cancelled: false, cleared };
      },
      (r) =>
        r.cancelled
          ? "저장하지 않았습니다"
          : r.cleared.length > 0
            ? `저장했습니다. 비밀키 ${r.cleared.join(", ")}가 지워졌습니다 — 아래 비밀키 칸에서 다시 입력하세요`
            : "저장했습니다",
    );

  const input = (key: keyof FormState, extra: Record<string, unknown> = {}) => ({
    value: String(form[key]),
    onInput: (e: Event) => set(key, (e.currentTarget as HTMLInputElement).value as never),
    ...extra,
  });

  return (
    <Modal
      title={isNew ? "MCP 서버 추가" : `MCP 서버 ${props.entry!.config.id}`}
      onClose={props.onClose}
      actions={
        !isNew && (
          <button
            class="danger"
            onClick={() =>
              confirm(`MCP 서버 ${props.entry!.config.id}을(를) 지울까요?`) &&
              action.run(async () => {
                await api("DELETE", `/mcp/servers/${enc(props.entry!.config.id)}`);
                await props.onSaved("");
                props.onClose();
              })
            }
          >
            삭제
          </button>
        )
      }
    >
      {action.view}
      {props.entry?.config.source.kind === "plugin" && (
        <Notice tone="info">plugin {props.entry.config.source.pluginId}가 등록한 서버입니다. 여기서 바꾼 env·범위·도구 필터는 plugin을 업데이트해도 유지됩니다.</Notice>
      )}
      <div class="grid-2">
        <label class="field">
          <span>id</span>
          <input {...input("id", { disabled: !isNew, pattern: "[a-z0-9][a-z0-9_\\-]{0,47}", required: true })} />
        </label>
        <label class="field">
          <span>표시 이름</span>
          <input {...input("displayName")} />
        </label>
        <label class="field">
          <span>실행 위치</span>
          <select value={form.runIn} onChange={(e) => set("runIn", (e.currentTarget as HTMLSelectElement).value as FormState["runIn"])}>
            <option value="broker">broker (원격 HTTP 서버, 비밀키 사용)</option>
            <option value="sandbox">sandbox (stdio, 비밀키 없음)</option>
          </select>
        </label>
        <label class="field">
          <span>범위</span>
          <select value={form.scope} onChange={(e) => set("scope", (e.currentTarget as HTMLSelectElement).value as McpScope)}>
            <option value="shared">shared</option>
            <option value="per-user">per-user</option>
            <option value="per-session">per-session</option>
          </select>
        </label>
        <label class="field">
          <span>timeout (초)</span>
          <input type="number" min={1} max={3600} {...input("timeoutSec")} />
        </label>
      </div>
      {form.runIn === "sandbox" ? (
        <div class="grid-2">
          <label class="field">
            <span>command</span>
            <input class="mono" {...input("command")} />
          </label>
          <label class="field">
            <span>cwd (선택)</span>
            <input class="mono" {...input("cwd")} />
          </label>
          <label class="field">
            <span>args (한 줄에 하나)</span>
            <textarea rows={4} class="mono" value={form.args} onInput={(e) => set("args", (e.currentTarget as HTMLTextAreaElement).value)} />
          </label>
          <label class="field">
            <span>env (KEY=VALUE)</span>
            <textarea rows={4} class="mono" value={form.env} onInput={(e) => set("env", (e.currentTarget as HTMLTextAreaElement).value)} />
          </label>
        </div>
      ) : (
        <div class="grid-2">
          <label class="field">
            <span>url</span>
            <input class="mono" {...input("url")} />
          </label>
          <label class="field">
            <span>headers (Name: value)</span>
            <textarea rows={4} class="mono" value={form.headers} onInput={(e) => set("headers", (e.currentTarget as HTMLTextAreaElement).value)} />
          </label>
        </div>
      )}
      <Placeholders />
      <div class="grid-2">
        <label class="field">
          <span>허용할 도구 (쉼표, 비우면 전체)</span>
          <input class="mono" {...input("toolAllow")} />
        </label>
        <label class="field">
          <span>막을 도구 (쉼표)</span>
          <input class="mono" {...input("toolDeny")} />
        </label>
      </div>
      <label class="field">
        <span>설명</span>
        <input {...input("description")} />
      </label>
      <label class="checkbox">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", (e.currentTarget as HTMLInputElement).checked)} /> 사용
      </label>
      {errors.length > 0 && (
        <Notice tone="error">
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div class="row">
        <button onClick={() => action.run(async () => (await validate()).ok, (ok) => (ok ? "설정이 올바릅니다" : "설정에 오류가 있습니다"))}>검증</button>
        <button class="primary" disabled={action.busy} onClick={save}>
          저장
        </button>
      </div>
      {!isNew && props.entry!.store === "broker" && <Secrets entry={props.entry!} required={required} onChanged={() => props.onSaved(props.entry!.config.id)} />}
      {!isNew && props.entry!.store === "broker" && <ToolsList id={props.entry!.config.id} />}
    </Modal>
  );
}

function Secrets(props: { entry: McpServerEntry; required: string[]; onChanged: () => Promise<void> }) {
  const action = useAction();
  const [values, setValues] = useState<Record<string, string>>({});
  const set = new Map((props.entry.secrets ?? []).map((s) => [s.name, s]));
  const names = [...new Set([...props.required, ...set.keys()])].sort();
  const id = props.entry.config.id;
  const save = (name: string) =>
    action.run(async () => {
      await api("PUT", `/mcp/servers/${enc(id)}/secrets/${enc(name)}`, { value: values[name] ?? "" });
      setValues((v) => ({ ...v, [name]: "" }));
      await props.onChanged();
    }, `${name}을(를) 저장했습니다`);
  return (
    <div class="subsection">
      <h3>비밀키</h3>
      <p class="muted small-text">값은 broker에만 저장되고 다시 읽을 수 없습니다. 바꾸려면 새 값을 입력하세요.</p>
      {action.view}
      <table class="table">
        <tbody>
          {names.map((name) => {
            const info = set.get(name);
            return (
              <tr key={name}>
                <td class="mono">{name}</td>
                <td>{info ? <Badge tone="green" title={`fingerprint ${info.fingerprint}`}>{`설정됨 · ${formatTime(info.setAt)}`}</Badge> : <Badge tone="amber">없음</Badge>}</td>
                <td>
                  <input
                    type="password"
                    autocomplete="new-password"
                    placeholder="새 값"
                    value={values[name] ?? ""}
                    onInput={(e) => setValues((v) => ({ ...v, [name]: (e.currentTarget as HTMLInputElement).value }))}
                  />
                </td>
                <td class="actions">
                  <button class="small primary" disabled={!values[name] || action.busy} onClick={() => save(name)}>
                    저장
                  </button>
                  {info && (
                    <button
                      class="small danger"
                      onClick={() =>
                        confirm(`${name}을(를) 지울까요?`) &&
                        action.run(async () => {
                          await api("DELETE", `/mcp/servers/${enc(id)}/secrets/${enc(name)}`);
                          await props.onChanged();
                        })
                      }
                    >
                      삭제
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ToolsList(props: { id: string }) {
  const [tools, setTools] = useState<ToolSummary[] | null>(null);
  const action = useAction();
  return (
    <div class="subsection">
      <h3>도구</h3>
      {action.view}
      {tools === null ? (
        <button
          class="small"
          onClick={() =>
            action.run(async () => {
              const result = await testServer(props.id);
              if (!result.ok) throw new Error(result.error ?? "연결 실패");
              setTools(result.tools ?? []);
            })
          }
        >
          도구 목록 불러오기
        </button>
      ) : (
        <ul class="plain-list">
          {tools.length === 0 && <li class="muted">도구가 없습니다.</li>}
          {tools.map((t) => (
            <li key={t.name}>
              <span class="mono">{t.name}</span> <span class="muted">{t.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
