import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText } from "../api";
import { Badge, Modal, Notice, RunsInBadge, Section, Toggle, useAction } from "../components";
import type { AgentToolset, PluginView, ToolInfo } from "../types";

// 도구·skill·agent 탭: 목록을 누르면 정의가 창으로 뜬다. 연 항목은 주소(#/<탭>/<이름>)에 남겨 plugin 탭에서 바로 연다.

interface Item {
  name: string;
  description: string;
  badge?: ComponentChildren;
}

/** 목록에 보이는 설명 첫 줄 */
function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function Explorer(props: {
  page: string;
  title: string;
  items: Item[] | null;
  error: string | null;
  selected?: string | undefined;
  empty: string;
  children: (name: string, close: () => void) => ComponentChildren;
}) {
  if (props.error) return <Notice tone="error">{props.error}</Notice>;
  if (!props.items) return <p class="muted">불러오는 중…</p>;
  const selected = props.items.find((i) => i.name === props.selected)?.name;
  return (
    <Section title={props.title} actions={<span class="muted small-text">{props.items.length}개</span>}>
      <table class="table">
        <thead>
          <tr>
            <th>이름</th>
            <th>설명</th>
          </tr>
        </thead>
        <tbody>
          {props.items.length === 0 && (
            <tr>
              <td colSpan={2} class="muted">
                {props.empty}
              </td>
            </tr>
          )}
          {props.items.map((i) => (
            <tr key={i.name} class="clickable" onClick={() => (location.hash = `#/${props.page}/${enc(i.name)}`)}>
              <td class="nowrap">
                <span class="mono">{i.name}</span> {i.badge}
              </td>
              <td class="muted small-text">{firstLine(i.description)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && props.children(selected, () => (location.hash = `#/${props.page}`))}
    </Section>
  );
}

function usePlugins() {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ plugins: PluginView[] }>("GET", "/plugins").then(
      (r) => setPlugins(r.plugins),
      (e) => setError(errorText(e)),
    );
  }, []);
  return { plugins, error };
}

function PluginLine(props: { plugin: PluginView }) {
  return (
    <p class="small-text muted">
      plugin <a href="#/plugins">{props.plugin.id}</a> {!props.plugin.enabled && <Badge tone="amber">꺼짐</Badge>}
    </p>
  );
}

export function ToolsPage(props: { focus?: string | undefined }) {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();
  const load = () =>
    api<{ tools: ToolInfo[] }>("GET", "/tools").then(
      (r) => setTools(r.tools),
      (e) => setError(errorText(e)),
    );
  useEffect(() => {
    void load();
  }, []);
  return (
    <Explorer
      page="tools"
      title="기본 도구"
      items={
        tools &&
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          badge: (
            <>
              <RunsInBadge value={t.runsIn} /> {!t.enabled && <Badge tone="amber">꺼짐</Badge>}
            </>
          ),
        }))
      }
      error={error}
      selected={props.focus}
      empty="도구가 없습니다."
    >
      {(name, close) => {
        const t = tools!.find((x) => x.name === name)!;
        return (
          <Modal
            title={
              <>
                <span class="mono">{t.name}</span> <RunsInBadge value={t.runsIn} />
              </>
            }
            onClose={close}
            actions={
              <Toggle
                checked={t.enabled}
                label={`${t.name} 사용`}
                disabled={action.busy}
                onChange={(next) =>
                  action.run(async () => {
                    await api("POST", `/tools/${enc(t.name)}/${next ? "enable" : "disable"}`);
                    await load();
                  })
                }
              />
            }
          >
            {action.view}
            <p class="small-text muted">
              {t.runsIn === "sandbox" ? "사용자 sandbox 컨테이너 안에서 실행됩니다." : "gateway 안에서 실행됩니다 (파일·명령을 직접 다루지 않습니다)."}{" "}
              끄면 새 대화와 대화 중인 세션의 다음 턴부터 모델(plugin agent 포함)에게 이 도구를 주지 않습니다.
            </p>
            {t.name === "read" && <p class="small-text warn-text">read를 끄면 모델이 skill 파일(SKILL.md)을 읽지 못합니다.</p>}
            <h3>설명</h3>
            <pre class="code-block">{t.description}</pre>
            {t.promptGuidelines && (
              <>
                <h3>지침</h3>
                <ul>
                  {t.promptGuidelines.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </>
            )}
            <h3>입력 스키마</h3>
            <pre class="code-block mono">{JSON.stringify(t.parameters, null, 2)}</pre>
          </Modal>
        );
      }}
    </Explorer>
  );
}

export function SkillsPage(props: { focus?: string | undefined }) {
  const { plugins, error } = usePlugins();
  const skills = plugins?.flatMap((plugin) => plugin.components.skills.map((skill) => ({ plugin, skill }))) ?? null;
  return (
    <Explorer
      page="skills"
      title="skill"
      items={skills && skills.map((s) => ({ name: s.skill.name, description: s.skill.description, badge: !s.plugin.enabled && <Badge tone="amber">꺼짐</Badge> }))}
      error={error}
      selected={props.focus}
      empty="설치된 plugin에 skill이 없습니다."
    >
      {(name, close) => {
        const { plugin, skill } = skills!.find((s) => s.skill.name === name)!;
        return <SkillDetail key={name} plugin={plugin} skill={skill} onClose={close} />;
      }}
    </Explorer>
  );
}

function SkillDetail(props: { plugin: PluginView; skill: PluginView["components"]["skills"][number]; onClose: () => void }) {
  const { plugin, skill } = props;
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ content: string }>("GET", `/plugins/${enc(plugin.id)}/skills/${enc(skill.name)}`).then(
      (r) => setContent(r.content),
      (e) => setError(errorText(e)),
    );
  }, []);
  return (
    <Modal title={<span class="mono">{skill.name}</span>} onClose={props.onClose}>
      <PluginLine plugin={plugin} />
      <p>{skill.description}</p>
      {skill.disableModelInvocation && <Badge tone="gray">모델이 스스로 부르지 않음</Badge>}
      <p class="small-text muted mono">{skill.filePath}</p>
      <h3>SKILL.md</h3>
      {error ? <Notice tone="error">{error}</Notice> : content === null ? <p class="muted">불러오는 중…</p> : <pre class="code-block">{content}</pre>}
    </Modal>
  );
}

export function AgentsPage(props: { focus?: string | undefined }) {
  const { plugins, error } = usePlugins();
  const [toolsets, setToolsets] = useState<AgentToolset[] | null>(null);
  useEffect(() => {
    api<{ agents: AgentToolset[] }>("GET", "/tools").then(
      (r) => setToolsets(r.agents),
      () => setToolsets([]),
    );
  }, []);
  const agents = plugins?.flatMap((plugin) => plugin.components.agents.map((agent) => ({ plugin, agent }))) ?? null;
  return (
    <Explorer
      page="agents"
      title="agent"
      items={agents && agents.map((a) => ({ name: a.agent.name, description: a.agent.description, badge: !a.plugin.enabled && <Badge tone="amber">꺼짐</Badge> }))}
      error={error}
      selected={props.focus}
      empty="설치된 plugin에 agent가 없습니다."
    >
      {(name, close) => {
        const { plugin, agent } = agents!.find((a) => a.agent.name === name)!;
        return (
          <Modal title={<span class="mono">{agent.name}</span>} onClose={close}>
            <PluginLine plugin={plugin} />
            <p>{agent.description}</p>
            <AgentGets toolset={toolsets?.find((t) => t.name === name)} loading={toolsets === null} declared={agent.tools} />
            {agent.notes.map((n) => (
              <div key={n} class="small-text warn-text">
                {n}
              </div>
            ))}
            <p class="small-text muted mono">{agent.filePath}</p>
            <h3>시스템 프롬프트</h3>
            <pre class="code-block">{agent.prompt}</pre>
          </Modal>
        );
      }}
    </Explorer>
  );
}

/** agent가 실행될 때 받는 것. 하위 세션에는 skill 목록을 넣지 않고 AskUserQuestion·Agent·SendMessage도 주지 않는다. */
function AgentGets(props: { toolset: AgentToolset | undefined; loading: boolean; declared: string[] | undefined }) {
  const { toolset } = props;
  return (
    <table class="table compact">
      <tbody>
        <tr>
          <th>기본 도구</th>
          <td>
            {props.loading ? (
              <span class="muted">불러오는 중…</span>
            ) : !toolset ? (
              <span class="muted">plugin이 꺼져 있어 쓰이지 않습니다</span>
            ) : toolset.tools.length === 0 ? (
              <span class="muted">없음</span>
            ) : (
              toolset.tools.map((t, i) => (
                <span key={t}>
                  {i > 0 && ", "}
                  <a class="mono" href={`#/tools/${enc(t)}`}>
                    {t}
                  </a>
                </span>
              ))
            )}
          </td>
        </tr>
        <tr>
          <th>MCP 도구</th>
          <td>
            {toolset?.mcp === "all" ? (
              <span>
                세션의 <a href="#/mcp">MCP 도구</a> 전부
              </span>
            ) : toolset && toolset.mcp.length > 0 ? (
              <span class="mono">{toolset.mcp.join(", ")}</span>
            ) : (
              <span class="muted">없음</span>
            )}
          </td>
        </tr>
        <tr>
          <th>skill</th>
          <td class="muted">없음 (하위 agent에는 skill 목록을 넣지 않습니다)</td>
        </tr>
        <tr>
          <th>frontmatter tools</th>
          <td>{props.declared ? <span class="mono">{props.declared.join(", ")}</span> : <span class="muted">지정 안 함 (AskUserQuestion·Agent·SendMessage를 뺀 전부)</span>}</td>
        </tr>
      </tbody>
    </table>
  );
}
