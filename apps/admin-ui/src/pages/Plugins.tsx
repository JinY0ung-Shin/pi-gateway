import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText, formatTime } from "../api";
import { Badge, EmptyRow, linesToRecord, Modal, Notice, recordToLines, Section, Toggle, useAction } from "../components";
import type { CatalogEntry, MarketplaceView, McpServerList, PluginView } from "../types";

const MCP_STATUS_LABEL: Record<string, string> = {
  unsupported: "지원 안 함",
  error: "오류",
  broker_unavailable: "broker 연결 실패",
};

const UNSUPPORTED_LABEL: Record<string, string> = {
  lsp: "LSP",
  "output-styles": "output styles",
  bin: "bin/",
  "user-config": "userConfig",
  dependencies: "plugin 의존성",
  "npm-dependencies": "npm 의존성",
  "mcp-bundle": "MCP bundle",
};

export function PluginsPage() {
  const [marketplaces, setMarketplaces] = useState<MarketplaceView[]>([]);
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  /** MCP 서버 id → 아직 넣지 않은 비밀키 (plugin 기록이 아니라 MCP 목록의 지금 상태) */
  const [missingSecrets, setMissingSecrets] = useState<Map<string, string[]>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      const [m, p, s] = await Promise.all([
        api<{ marketplaces: MarketplaceView[] }>("GET", "/marketplaces"),
        api<{ plugins: PluginView[] }>("GET", "/plugins"),
        api<McpServerList>("GET", "/mcp/servers"),
      ]);
      setMarketplaces(m.marketplaces);
      setPlugins(p.plugins);
      setMissingSecrets(new Map(s.servers.map((e) => [e.config.id, e.missingSecrets ?? []])));
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
      <Marketplaces marketplaces={marketplaces} onSelect={setSelected} onChanged={reload} />
      {selected && <Catalog key={selected} name={selected} onInstalled={reload} onClose={() => setSelected(null)} />}
      <Installed plugins={plugins} missingSecrets={missingSecrets} onChanged={reload} />
      <McpDefaults />
    </>
  );
}

function Marketplaces(props: { marketplaces: MarketplaceView[]; onSelect: (name: string) => void; onChanged: () => Promise<void> }) {
  const action = useAction();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");

  const refresh = (name: string, body: { ref?: string } = {}) =>
    action.run(async () => {
      const result = await api<{ updated: string[]; warnings: string[] }>("POST", `/marketplaces/${enc(name)}/refresh`, body);
      await props.onChanged();
      return result;
    }, (r) => {
      const done =
        body.ref !== undefined
          ? `${name}의 branch를 바꾸고 설치된 plugin을 다시 설치했습니다`
          : r.updated.length
            ? `${name}을(를) 새로고침하고 ${r.updated.join(", ")}을(를) 업데이트했습니다`
            : `${name}을(를) 새로고침했습니다 (새 버전 없음)`;
      return r.warnings.length ? `${done}. 확인할 점: ${r.warnings.join(" / ")}` : done;
    });

  const add = (e: Event) => {
    e.preventDefault();
    void action.run(async () => {
      const created = await api<MarketplaceView>("POST", "/marketplaces", { url, ...(ref ? { ref } : {}) });
      setUrl("");
      setRef("");
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
          {props.marketplaces.length === 0 && <EmptyRow cols={6}>추가된 marketplace가 없습니다.</EmptyRow>}
          {props.marketplaces.map((m) => (
            <tr key={m.name} class="clickable" title="눌러서 plugin을 설치합니다" onClick={() => props.onSelect(m.name)}>
              <td>
                {m.name} {m.owner && <span class="muted small-text">{m.owner}</span>}
              </td>
              <td class="clip mono" title={m.url}>
                {m.url}
                {m.ref ? `#${m.ref}` : ""}
              </td>
              <td class="mono">{m.commitSha.slice(0, 7)}</td>
              <td>
                {m.pluginCount}개 {m.invalidEntries > 0 && <Badge tone="amber">{`읽지 못한 항목 ${m.invalidEntries}`}</Badge>}
              </td>
              <td>{formatTime(m.refreshedAt)}</td>
              <td class="actions" onClick={(e) => e.stopPropagation()}>
                <button class="small" disabled={action.busy} onClick={() => void refresh(m.name)}>
                  새로고침
                </button>
                <button
                  class="small"
                  disabled={action.busy}
                  onClick={() => {
                    const next = prompt("branch·tag (비우면 기본 브랜치). 이 marketplace에서 설치한 plugin도 그 branch로 다시 설치합니다.", m.ref ?? "");
                    if (next !== null) void refresh(m.name, { ref: next.trim() });
                  }}
                >
                  branch 변경
                </button>
                <button
                  class="small danger"
                  onClick={() =>
                    confirm(`marketplace ${m.name}을(를) 지울까요?`) &&
                    action.run(async () => {
                      await api("DELETE", `/marketplaces/${enc(m.name)}`);
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
        <input class="grow mono" placeholder="https://github.com/org/marketplace.git 또는 org/repo" value={url} onInput={(e) => setUrl(e.currentTarget.value)} required />
        <input placeholder="branch·tag (선택)" value={ref} onInput={(e) => setRef(e.currentTarget.value)} />
        <button class="primary" type="submit" disabled={action.busy}>
          {action.busy ? "받는 중…" : "추가"}
        </button>
      </form>
      <p class="muted small-text">비공개 저장소는 gateway에 설정한 PLUGIN_GIT_TOKEN으로 받습니다 (운영 가이드 §4).</p>
    </Section>
  );
}

function Catalog(props: { name: string; onInstalled: () => Promise<void>; onClose: () => void }) {
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

  const update = (id: string, version: string) =>
    action.run(async () => {
      await api("POST", `/plugins/${enc(id)}/update`, {});
      await load();
      await props.onInstalled();
    }, `${id}을(를) 업데이트했습니다 (v${version})`);

  return (
    <Modal title={`${props.name}의 plugin`} onClose={props.onClose}>
      {action.view}
      {entries === null ? (
        <p class="muted">불러오는 중…</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>이름</th>
              <th>설명</th>
              <th title="marketplace.json 항목에 적힌 버전">표기 버전</th>
              <th title="설치본의 plugin.json 버전">설치 상태</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.name}>
                <td class="mono" title={e.source}>
                  {e.name}
                </td>
                <td class="clip muted" title={e.description}>
                  {e.description}
                </td>
                <td>{e.listedVersion ?? <span class="muted">-</span>}</td>
                <td class="actions">
                  {e.installed ? (
                    <>
                      {!e.installed.update && e.listedVersion && e.listedVersion !== e.installed.version ? (
                        <Badge tone="amber" title={`marketplace 표기(${e.listedVersion})와 설치본 plugin.json 버전이 다릅니다`}>{`설치됨 v${e.installed.version}`}</Badge>
                      ) : (
                        <Badge tone="green" title="설치본 plugin.json의 버전">{`설치됨 v${e.installed.version}`}</Badge>
                      )}
                      {e.installed.update && (
                        <button class="small primary" disabled={action.busy} onClick={() => update(e.installed!.id, e.installed!.update!.version)}>
                          {`업데이트 (v${e.installed.update.version})`}
                        </button>
                      )}
                    </>
                  ) : e.supported ? (
                    <button class="small primary" disabled={action.busy} onClick={() => install(e)}>
                      설치
                    </button>
                  ) : (
                    <Badge tone="red" title={`받는 방식을 지원하지 않습니다: ${e.source}`}>
                      지원 안 함
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function Installed(props: { plugins: PluginView[]; missingSecrets: Map<string, string[]>; onChanged: () => Promise<void> }) {
  const action = useAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = props.plugins.find((p) => p.id === openId);
  const needsSecret = (p: PluginView) => p.mcp.some((m) => m.status === "registered" && m.id && (props.missingSecrets.get(m.id) ?? []).length > 0);
  return (
    <Section title="설치된 plugin" actions={<span class="muted small-text">{props.plugins.length}개</span>}>
      {action.view}
      <table class="table">
        <thead>
          <tr>
            <th>plugin</th>
            <th>구성</th>
            <th>확인할 점</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.plugins.length === 0 && <EmptyRow cols={4}>설치된 plugin이 없습니다.</EmptyRow>}
          {props.plugins.map((p) => {
            const c = p.components;
            const parts = [
              c.skills.length > 0 && `skill ${c.skills.length}`,
              c.agents.length > 0 && `agent ${c.agents.length}`,
              c.commands.length > 0 && `command ${c.commands.length}`,
              p.mcp.length > 0 && `MCP ${p.mcp.length}`,
            ].filter(Boolean);
            const failed = p.mcp.filter((m) => m.status !== "registered").length;
            const notes = c.unsupported.length + c.warnings.length + c.copySkipped.length;
            return (
              <tr key={p.id} class="clickable" onClick={() => setOpenId(p.id)}>
                <td>
                  <span class="mono">{p.id}</span> <Badge>{p.version}</Badge>
                  {p.update && <Badge tone="blue">{`업데이트 있음 v${p.update.version}`}</Badge>}
                </td>
                <td class="clip muted">{parts.join(" · ") || "-"}</td>
                <td>
                  {failed > 0 && <Badge tone="red">{`MCP ${failed}개 등록 안 됨`}</Badge>}
                  {needsSecret(p) && <Badge tone="amber">비밀키 필요</Badge>}
                  {notes > 0 && <Badge tone="amber">{`경고 ${notes}`}</Badge>}
                </td>
                <td class="actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    class={p.update ? "small primary" : "small"}
                    disabled={action.busy}
                    onClick={() =>
                      action.run(
                        async () => {
                          await api("POST", `/plugins/${enc(p.id)}/update`, {});
                          await props.onChanged();
                        },
                        p.update ? `${p.id}을(를) 업데이트했습니다 (v${p.update.version})` : `${p.id}을(를) 다시 설치했습니다`,
                      )
                    }
                  >
                    {p.update ? `업데이트 (v${p.update.version})` : "다시 설치"}
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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="muted small-text">
        marketplace를 새로고침하면 새 버전이 있는 plugin을 바로 업데이트합니다. gateway도 1시간마다 새로고침합니다. 업데이트하지 못한 plugin에는 '업데이트 있음'이 남습니다. branch를 바꾸면 그 marketplace의 plugin을 모두 다시 설치합니다. 다른 git 저장소에서 받는 plugin은 marketplace가 고정한 sha나 버전이 바뀔 때만
        알 수 있으니, 그 밖의 경우는 '다시 설치'로 최신 내용을 받으세요. 바뀐 내용은 새 세션부터 적용됩니다.
      </p>
      {open && <PluginDetail plugin={open} missingSecrets={props.missingSecrets} onClose={() => setOpenId(null)} />}
    </Section>
  );
}

/** plugin 하나가 설치한 것과 설치하면서 남긴 경고 */
function PluginDetail(props: { plugin: PluginView; missingSecrets: Map<string, string[]>; onClose: () => void }) {
  const p = props.plugin;
  return (
    <Modal
      title={
        <>
          <span class="mono">{p.id}</span> <Badge>{p.version}</Badge>
          {!p.enabled && <Badge tone="amber">꺼짐</Badge>}
        </>
      }
      onClose={props.onClose}
    >
      {p.description && <p>{p.description}</p>}
      <p class="small-text muted">
        {p.source.display} · {formatTime(p.updatedAt)} 설치
      </p>
      <table class="table compact">
        <tbody>
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
              ) : m.id && (props.missingSecrets.get(m.id) ?? []).length > 0 ? (
                <Badge tone="amber">비밀키 필요</Badge>
              ) : null,
          }))}
        />
        </tbody>
      </table>
      {p.components.unsupported.length > 0 && (
        <>
          <h3>지원하지 않아 건너뛴 것</h3>
          <p>
            {p.components.unsupported.map((u) => (
              <Badge key={u.kind} tone="amber" title={u.detail}>
                {UNSUPPORTED_LABEL[u.kind] ?? u.kind}
              </Badge>
            ))}
          </p>
        </>
      )}
      {(p.components.warnings.length > 0 || p.components.copySkipped.length > 0) && (
        <>
          <h3>경고</h3>
          <ul class="plain-list">
            {p.components.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {p.components.copySkipped.map((s) => (
              <li key={s.path}>
                건너뛴 파일 <span class="mono">{s.path}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** plugin이 추가한 구성요소 이름. 자세한 내용은 각 탭에서 본다. */
function Names(props: { label: string; items: { name: string; href?: string; title?: string; badge?: ComponentChildren }[] }) {
  if (props.items.length === 0) return null;
  return (
    <tr>
      <th>{props.label}</th>
      <td class="wrap">
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
      </td>
    </tr>
  );
}

function McpDefaults() {
  const action = useAction();
  const [env, setEnv] = useState("");
  useEffect(() => {
    void action.run(async () => {
      const s = await api<{ mcpDefaults: { env: Record<string, string> } }>("GET", "/plugin-settings");
      setEnv(recordToLines(s.mcpDefaults.env));
    });
  }, []);
  return (
    <Section title="plugin MCP 기본값">
      <p class="muted small-text">
        plugin이 설치하는 sandbox 실행 MCP 서버 중 그 변수를 실제로 읽는 서버에만 넣는 env입니다. 예: <code>THREAD_ID={"{{metadata:THREAD_ID}}"}</code>,{" "}
        <code>ORCHESTRATOR_URL={"{{metadata:ORCHESTRATOR_URL}}"}</code>, <code>SERVICE_URL=http://orchestrator:9000</code>. metadata 키는 대소문자를 구분하고 gateway의
        MCP_METADATA_KEYS에 있어야 합니다. http(broker) 서버가 같은 이름의 비밀키를 쓰면, MCP 탭에서 따로 넣지 않은 경우 이 값으로 채웁니다. 저장하면 설치된 plugin의
        MCP 서버에도 바로 적용됩니다 (MCP 탭에서 직접 바꾼 값은 그대로 둡니다).
      </p>
      {action.view}
      <label class="field">
        <span>env (KEY=VALUE)</span>
        <textarea rows={4} class="mono" value={env} onInput={(e) => setEnv(e.currentTarget.value)} />
      </label>
      <button class="primary" disabled={action.busy} onClick={() =>
          action.run(
            () => api<{ warnings: string[] }>("PUT", "/plugin-settings", { mcpDefaults: { env: linesToRecord(env) } }),
            (r) => (r.warnings.length ? `저장했습니다. 확인할 점: ${r.warnings.join(" / ")}` : "저장하고 설치된 plugin의 MCP 서버에 적용했습니다"),
          )
        }>
        저장
      </button>
    </Section>
  );
}
