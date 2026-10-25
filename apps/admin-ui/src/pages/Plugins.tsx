import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText, formatTime } from "../api";
import { Badge, linesToRecord, Notice, recordToLines, Section, Toggle, useAction } from "../components";
import type { CatalogEntry, MarketplaceView, McpScope, PluginView } from "../types";

const MCP_STATUS_LABEL: Record<string, string> = {
  unsupported: "지원 안 함",
  error: "오류",
  broker_unavailable: "broker 없음",
};

const UNSUPPORTED_LABEL: Record<string, string> = {
  hooks: "hooks",
  lsp: "LSP",
  "output-styles": "output styles",
  workflows: "workflows",
  monitors: "monitors",
  themes: "themes",
  bin: "bin/",
  "user-config": "userConfig",
  channels: "channels",
  settings: "settings",
  dependencies: "plugin 의존성",
  "npm-dependencies": "npm 의존성",
  "mcp-bundle": "MCP bundle",
};

export function PluginsPage() {
  const [marketplaces, setMarketplaces] = useState<MarketplaceView[]>([]);
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [m, p] = await Promise.all([
        api<{ marketplaces: MarketplaceView[] }>("GET", "/marketplaces"),
        api<{ plugins: PluginView[] }>("GET", "/plugins"),
      ]);
      setMarketplaces(m.marketplaces);
      setPlugins(p.plugins);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      <Marketplaces marketplaces={marketplaces} selected={selected} onSelect={setSelected} onChanged={reload} />
      {selected && <Catalog key={selected} name={selected} onInstalled={reload} />}
      <Installed plugins={plugins} onChanged={reload} />
      <McpDefaults />
    </>
  );
}

function Marketplaces(props: { marketplaces: MarketplaceView[]; selected: string | null; onSelect: (name: string | null) => void; onChanged: () => Promise<void> }) {
  const action = useAction();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [token, setToken] = useState("");
  const [tokenUsername, setTokenUsername] = useState("");

  const add = (e: Event) => {
    e.preventDefault();
    void action.run(async () => {
      const created = await api<MarketplaceView>("POST", "/marketplaces", {
        url,
        ...(ref ? { ref } : {}),
        ...(token ? { token } : {}),
        ...(tokenUsername ? { tokenUsername } : {}),
      });
      setUrl("");
      setRef("");
      setToken("");
      await props.onChanged();
      props.onSelect(created.name);
    }, "marketplace를 추가했습니다");
  };

  return (
    <Section title="Marketplace">
      {action.view}
      <table class="table">
        <thead>
          <tr>
            <th>이름</th>
            <th>저장소</th>
            <th>커밋</th>
            <th>plugin</th>
            <th>새로고침</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.marketplaces.length === 0 && (
            <tr>
              <td colSpan={6} class="muted">
                추가된 marketplace가 없습니다.
              </td>
            </tr>
          )}
          {props.marketplaces.map((m) => (
            <tr key={m.name} class={props.selected === m.name ? "selected" : ""}>
              <td>
                <button class="link" onClick={() => props.onSelect(props.selected === m.name ? null : m.name)}>
                  {m.name}
                </button>
                {m.owner && <div class="muted small-text">{m.owner}</div>}
              </td>
              <td class="mono small-text">
                {m.url}
                {m.ref ? `#${m.ref}` : ""}
              </td>
              <td class="mono small-text">{m.commitSha.slice(0, 10)}</td>
              <td>
                {m.pluginCount}
                {m.invalidEntries > 0 && <Badge tone="amber">{`읽지 못한 항목 ${m.invalidEntries}`}</Badge>}
              </td>
              <td>{formatTime(m.refreshedAt)}</td>
              <td class="actions">
                <button
                  class="small"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const t = prompt("비공개 저장소면 token을 입력하세요 (공개면 비워 두세요)") ?? "";
                      await api("POST", `/marketplaces/${enc(m.name)}/refresh`, t ? { token: t } : {});
                      await props.onChanged();
                    }, `${m.name}을(를) 새로고침했습니다`)
                  }
                >
                  새로고침
                </button>
                <button
                  class="small danger"
                  onClick={() =>
                    confirm(`marketplace ${m.name}을(를) 지울까요?`) &&
                    action.run(async () => {
                      await api("DELETE", `/marketplaces/${enc(m.name)}`);
                      if (props.selected === m.name) props.onSelect(null);
                      await props.onChanged();
                    })
                  }
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form class="row wrap" onSubmit={add}>
        <input class="grow mono" placeholder="https://github.com/org/marketplace.git 또는 org/repo" value={url} onInput={(e) => setUrl((e.currentTarget as HTMLInputElement).value)} required />
        <input placeholder="branch·tag (선택)" value={ref} onInput={(e) => setRef((e.currentTarget as HTMLInputElement).value)} />
        <input type="password" autocomplete="off" placeholder="token (비공개 저장소)" value={token} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)} />
        <input placeholder="token 사용자 (기본 x-access-token)" value={tokenUsername} onInput={(e) => setTokenUsername((e.currentTarget as HTMLInputElement).value)} />
        <button class="primary" type="submit" disabled={action.busy}>
          {action.busy ? "받는 중…" : "추가"}
        </button>
      </form>
      <p class="muted small-text">token은 저장하지 않습니다. 저장소를 받는 동안에만 쓰입니다.</p>
    </Section>
  );
}

function Catalog(props: { name: string; onInstalled: () => Promise<void> }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const action = useAction();
  const load = async () => setEntries((await api<{ plugins: CatalogEntry[] }>("GET", `/marketplaces/${enc(props.name)}`)).plugins);
  useEffect(() => {
    void action.run(load);
  }, [props.name]);

  const install = (entry: CatalogEntry) =>
    action.run(
      async () => {
        const result = await api<{ plugin: PluginView; warnings: string[] }>("POST", "/plugins/install", { marketplace: props.name, plugin: entry.name });
        await load();
        await props.onInstalled();
        return result;
      },
      (r) => (r.warnings.length ? `설치했습니다. 확인할 점: ${r.warnings.join(" / ")}` : "설치했습니다"),
    );

  return (
    <Section title={`${props.name}의 plugin`}>
      {action.view}
      {entries === null ? (
        <p class="muted">불러오는 중…</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>이름</th>
              <th>설명</th>
              <th title="marketplace.json 항목에 적힌 버전">marketplace 표기 버전</th>
              <th>source</th>
              <th title="설치본의 plugin.json 버전">설치 상태</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.name}>
                <td class="mono">{e.name}</td>
                <td>{e.description}</td>
                <td>{e.listedVersion ?? <span class="muted">-</span>}</td>
                <td class="mono small-text">
                  {e.source} {!e.supported && <Badge tone="red">지원 안 함</Badge>}
                </td>
                <td class="actions">
                  {e.installed ? (
                    <>
                      <Badge tone="green" title="설치본 plugin.json의 버전">{`설치됨 v${e.installed.version}`}</Badge>
                      {e.listedVersion && e.listedVersion !== e.installed.version && (
                        <div class="small-text muted">marketplace 표기({e.listedVersion})와 설치본 plugin.json 버전이 다릅니다</div>
                      )}
                    </>
                  ) : (
                    <button class="small primary" disabled={!e.supported || action.busy} onClick={() => install(e)}>
                      설치
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Installed(props: { plugins: PluginView[]; onChanged: () => Promise<void> }) {
  const action = useAction();
  return (
    <Section title="설치된 plugin">
      {action.view}
      {props.plugins.length === 0 && <p class="muted">설치된 plugin이 없습니다.</p>}
      <div class="cards">
        {props.plugins.map((p) => (
          <div class="card plugin-card" key={p.id}>
            <div class="row space">
              <div>
                <strong class="mono">{p.id}</strong> <Badge>{p.version}</Badge>
                {p.description && <div class="muted small-text">{p.description}</div>}
              </div>
              <Toggle
                checked={p.enabled}
                label={`${p.id} 사용`}
                disabled={action.busy}
                onChange={(next) =>
                  action.run(async () => {
                    await api("POST", `/plugins/${enc(p.id)}/${next ? "enable" : "disable"}`);
                    await props.onChanged();
                  })
                }
              />
            </div>
            <div class="small-text muted">
              {p.source.display} · {formatTime(p.updatedAt)}
            </div>
            <ul class="plain-list small-text">
              <Names label="skill" items={p.components.skills.map((s) => ({ name: s.name, href: `#/skills/${enc(s.name)}` }))} />
              <Names label="agent" items={p.components.agents.map((a) => ({ name: a.name, href: `#/agents/${enc(a.name)}` }))} />
              <Names label="command" items={p.components.commands.map((c) => ({ name: `/${c.name}`, title: c.notes.join(" ") }))} />
              <Names
                label="MCP"
                items={p.mcp.map((m) => ({
                  name: m.id ?? m.name,
                  ...(m.status === "registered" && m.id ? { href: `#/mcp/${enc(m.id)}` } : {}),
                  badge:
                    m.status !== "registered" ? (
                      <Badge tone="red" title={m.reason}>
                        {MCP_STATUS_LABEL[m.status] ?? m.status}
                      </Badge>
                    ) : (m.missingSecrets ?? []).length > 0 ? (
                      <Badge tone="amber">비밀키 필요</Badge>
                    ) : null,
                }))}
              />
            </ul>
            {p.components.unsupported.length > 0 && (
              <div class="row wrap">
                <span class="small-text muted">지원 안 함:</span>
                {p.components.unsupported.map((u) => (
                  <Badge key={u.kind} tone="amber" title={u.detail}>
                    {UNSUPPORTED_LABEL[u.kind] ?? u.kind}
                  </Badge>
                ))}
              </div>
            )}
            {(p.components.warnings.length > 0 || p.components.copySkipped.length > 0) && (
              <details>
                <summary class="warn-text">경고 {p.components.warnings.length + p.components.copySkipped.length}개</summary>
                <ul class="plain-list small-text">
                  {p.components.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                  {p.components.copySkipped.map((s) => (
                    <li key={s.path}>
                      건너뛴 파일 <span class="mono">{s.path}</span>: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div class="row">
              <button
                class="small"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api("POST", `/plugins/${enc(p.id)}/update`, {});
                    await props.onChanged();
                  }, `${p.id}을(를) 다시 설치했습니다`)
                }
              >
                업데이트
              </button>
              <button
                class="small danger"
                onClick={() =>
                  confirm(`${p.id}을(를) 제거할까요? 등록된 MCP 서버도 지워집니다.`) &&
                  action.run(async () => {
                    await api("DELETE", `/plugins/${enc(p.id)}`);
                    await props.onChanged();
                  })
                }
              >
                제거
              </button>
            </div>
          </div>
        ))}
      </div>
      <p class="muted small-text">새 버전을 받으려면 marketplace를 새로고침한 뒤 업데이트하세요. 바뀐 내용은 새 세션부터 적용됩니다.</p>
    </Section>
  );
}

/** plugin이 추가한 구성요소 이름. 자세한 내용은 각 탭에서 본다. */
function Names(props: { label: string; items: { name: string; href?: string; title?: string; badge?: ComponentChildren }[] }) {
  if (props.items.length === 0) return null;
  return (
    <li>
      <span class="muted">{props.label}</span>{" "}
      {props.items.map((i, index) => (
        <span key={i.name} title={i.title}>
          {index > 0 && ", "}
          {i.href ? (
            <a class="mono" href={i.href}>
              {i.name}
            </a>
          ) : (
            <span class="mono">{i.name}</span>
          )}
          {i.badge && <> {i.badge}</>}
        </span>
      ))}
    </li>
  );
}

function McpDefaults() {
  const action = useAction();
  const [env, setEnv] = useState("");
  const [scope, setScope] = useState<McpScope>("per-user");
  useEffect(() => {
    void action.run(async () => {
      const s = await api<{ mcpDefaults: { env: Record<string, string>; scope: McpScope } }>("GET", "/plugin-settings");
      setEnv(recordToLines(s.mcpDefaults.env));
      setScope(s.mcpDefaults.scope);
    });
  }, []);
  return (
    <Section title="plugin MCP 기본값">
      <p class="muted small-text">
        plugin이 설치하는 sandbox 실행 MCP 서버 중 그 변수를 실제로 읽는 서버에만 넣는 env입니다. 예: <code>THREAD_ID={"{{metadata:THREAD_ID}}"}</code>,{" "}
        <code>ORCHESTRATOR_URL={"{{metadata:ORCHESTRATOR_URL}}"}</code>, <code>SERVICE_URL=http://orchestrator:9000</code>. metadata 키는 대소문자를 구분하고 gateway의
        MCP_METADATA_KEYS에 있어야 합니다. 다음 설치·업데이트부터 적용됩니다.
      </p>
      {action.view}
      <div class="grid-2">
        <label class="field">
          <span>env (KEY=VALUE)</span>
          <textarea rows={4} class="mono" value={env} onInput={(e) => setEnv((e.currentTarget as HTMLTextAreaElement).value)} />
        </label>
        <label class="field">
          <span>범위</span>
          <select value={scope} onChange={(e) => setScope((e.currentTarget as HTMLSelectElement).value as McpScope)}>
            <option value="per-user">per-user (사용자마다 프로세스, 기본)</option>
            <option value="per-session">per-session (세션마다 프로세스)</option>
            <option value="shared">shared</option>
          </select>
        </label>
      </div>
      <button class="primary" disabled={action.busy} onClick={() => action.run(() => api("PUT", "/plugin-settings", { mcpDefaults: { env: linesToRecord(env), scope } }), "저장했습니다")}>
        저장
      </button>
    </Section>
  );
}
