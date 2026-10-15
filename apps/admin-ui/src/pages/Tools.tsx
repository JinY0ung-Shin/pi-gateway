import { useEffect, useState } from "preact/hooks";
import { api, enc, errorText, formatTime } from "../api";
import { Badge, Notice, RunsInBadge, Section, Toggle, useAction } from "../components";
import type { ToolList, ToolView } from "../types";

/** `mcp__<server>__*` → server */
function mcpServerOf(name: string): string | null {
  const match = /^mcp__([a-z0-9][a-z0-9_-]*)__\*$/.exec(name);
  return match?.[1] ?? null;
}

export function ToolsPage() {
  const [list, setList] = useState<ToolList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();

  const reload = async () => {
    try {
      setList(await api<ToolList>("GET", "/tools"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const toggle = (tool: ToolView, enabled: boolean) =>
    action.run(async () => {
      await api("PUT", `/tools/${enc(tool.name)}`, { enabled });
      await reload();
    }, `${tool.name}을(를) ${enabled ? "켰습니다" : "껐습니다"}`);

  const reset = (name: string) =>
    action.run(async () => {
      await api("DELETE", `/tools/${enc(name)}`);
      await reload();
    }, `${name}을(를) 기본값으로 되돌렸습니다`);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!list) return <p class="muted">불러오는 중…</p>;

  return (
    <Section title="도구">
      <p class="muted">
        모델에게 줄 도구를 켜고 끕니다. 바꾼 설정은 새 세션부터 적용됩니다. 필수 도구(예: skill을 읽는 read)는 끌 수 없습니다.
      </p>
      {action.view}
      {!list.catalogAvailable && <Notice tone="warn">gateway core가 아직 도구 목록을 제공하지 않습니다.</Notice>}
      <table class="table">
        <thead>
          <tr>
            <th>도구</th>
            <th>설명</th>
            <th>provider</th>
            <th>실행</th>
            <th>상태</th>
            <th>사용</th>
          </tr>
        </thead>
        <tbody>
          {list.tools.map((t) => {
            const server = t.dynamic ? mcpServerOf(t.name) : null;
            return (
              <tr key={t.name}>
                <td>
                  <span class="mono">{t.name}</span>
                  {t.required && (
                    <Badge tone="blue" title="끌 수 없는 도구">
                      필수
                    </Badge>
                  )}
                  {t.dynamic && (
                    <div class="small-text">
                      <a href={server ? `#/mcp/${enc(server)}` : "#/mcp"}>MCP 페이지에서 도구별로 설정 (toolAllow/toolDeny) →</a>
                    </div>
                  )}
                </td>
                <td>{t.description}</td>
                <td class="mono small-text">{t.provider}</td>
                <td>
                  <RunsInBadge value={t.runsIn} />
                </td>
                <td class="small-text">
                  {t.explicit ? (
                    <>
                      {t.updatedBy} · {formatTime(t.updatedAt)}{" "}
                      <button class="link" onClick={() => reset(t.name)}>
                        기본값으로
                      </button>
                    </>
                  ) : (
                    <span class="muted">기본값 ({t.enabledByDefault ? "켜짐" : "꺼짐"})</span>
                  )}
                </td>
                <td>
                  <Toggle
                    checked={t.enabled}
                    disabled={t.required || action.busy}
                    title={t.required ? "필수 도구는 끌 수 없습니다" : `${t.name} 사용`}
                    onChange={(next) => toggle(t, next)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {list.orphans.length > 0 && (
        <>
          <h3>목록에 없는 도구의 설정</h3>
          <ul class="plain-list">
            {list.orphans.map((o) => (
              <li key={o.name}>
                <span class="mono">{o.name}</span> {o.enabled ? <Badge tone="green">켜짐</Badge> : <Badge>꺼짐</Badge>}{" "}
                <span class="muted small-text">
                  {o.updatedBy} · {formatTime(o.updatedAt)}
                </span>{" "}
                <button class="link" onClick={() => reset(o.name)}>
                  설정 지우기
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
