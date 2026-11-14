import { type JSX, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { Brand, Notice } from "./components";
import { AgentsPage, SkillsPage, ToolsPage } from "./pages/Catalog";
import { ChatPage } from "./pages/Chat";
import { HistoryPage } from "./pages/History";
import { LlmPage } from "./pages/Llm";
import { Login } from "./pages/Login";
import { McpPage } from "./pages/Mcp";
import { PluginsPage } from "./pages/Plugins";
import { PromptsPage } from "./pages/Prompts";
import { RequestsPage } from "./pages/Requests";
import { StatusPage } from "./pages/Status";
import { SystemOnePage } from "./pages/SystemOne";
import { TimingPage } from "./pages/Timing";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./styles.css";

const PAGES: { id: string; group: string; label: string; desc: string; view: (arg?: string) => JSX.Element }[] = [
  { id: "llm", group: "모델", label: "LLM", desc: "모델 서버 연결과 세션에서 고를 수 있는 모델", view: () => <LlmPage /> },
  { id: "systemone", group: "모델", label: "System One", desc: "mcp_search가 도구를 고를 때 묻는 decision model 서버", view: () => <SystemOnePage /> },
  { id: "prompts", group: "모델", label: "프롬프트", desc: "모든 세션에 들어가는 시스템 프롬프트와 배포 이력", view: () => <PromptsPage /> },
  { id: "tools", group: "도구", label: "기본 도구", desc: "모든 세션이 받는 내장 도구의 정의", view: (arg) => <ToolsPage focus={arg} /> },
  { id: "mcp", group: "도구", label: "MCP", desc: "세션에 붙는 MCP 서버와 실행 위치", view: (arg) => <McpPage focus={arg} /> },
  { id: "skills", group: "도구", label: "skill", desc: "plugin이 설치한 skill과 SKILL.md", view: (arg) => <SkillsPage focus={arg} /> },
  { id: "agents", group: "도구", label: "agent", desc: "plugin agent와 실행될 때 받는 도구", view: (arg) => <AgentsPage focus={arg} /> },
  { id: "plugins", group: "설치", label: "plugin", desc: "marketplace에서 plugin을 설치하고 켜고 끕니다", view: () => <PluginsPage /> },
  { id: "status", group: "운영", label: "상태", desc: "LLM·broker·sandboxd 연결과 세션·sandbox·메모리 현황 (10초마다 갱신)", view: () => <StatusPage /> },
  { id: "timing", group: "운영", label: "실행 시간", desc: "최근 턴의 trace로 본 시간 통계: 턴 시간과 추이, 시간이 쓰인 곳, 모델 응답 속도, 느린 단계와 턴", view: () => <TimingPage /> },
  { id: "chat", group: "운영", label: "채팅 테스트", desc: "운영과 같은 도구·MCP·skill 구성으로 대화해 봅니다", view: () => <ChatPage /> },
  { id: "history", group: "운영", label: "대화 기록", desc: "서버에 저장된 세션의 대화·시스템 프롬프트와 보관 기간", view: (arg) => <HistoryPage focus={arg} /> },
  { id: "requests", group: "운영", label: "요청", desc: "agent가 request_admin으로 남긴 요청 (패키지 설치, 막힌 도메인, 없는 도구 등). 처리하면 지웁니다", view: () => <RequestsPage /> },
];
const GROUPS = [...new Set(PAGES.map((p) => p.group))];

function parseHash(): { page: string; arg?: string } {
  const [page, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const found = PAGES.find((p) => p.id === page);
  return { page: found ? found.id : "llm", ...(arg ? { arg: decodeURIComponent(arg) } : {}) };
}

function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out" | "disabled">("checking");
  const [route, setRoute] = useState(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener("hashchange", onHash);
    setUnauthorizedHandler(() => setAuth("out"));
    api("GET", "/session")
      .then(() => setAuth("in"))
      .catch((error) => setAuth(error instanceof ApiError && error.code === "admin_disabled" ? "disabled" : "out"));
    return () => removeEventListener("hashchange", onHash);
  }, []);

  if (auth === "checking") return <p class="center muted">불러오는 중…</p>;
  if (auth === "disabled") {
    return (
      <div class="login">
        <Notice tone="warn">관리 화면이 꺼져 있습니다. gateway에 ADMIN_API_KEY를 설정하세요.</Notice>
      </div>
    );
  }
  if (auth === "out") return <Login onLogin={() => setAuth("in")} />;

  const current = PAGES.find((p) => p.id === route.page)!;
  return (
    <div class="layout">
      <aside class="rail">
        <Brand />
        <nav aria-label="관리 메뉴">
          {GROUPS.map((group) => (
            <div key={group} class="rail-group">
              <div class="rail-label">{group}</div>
              <ul>
                {PAGES.filter((p) => p.group === group).map((p) => (
                  <li key={p.id}>
                    <a href={`#/${p.id}`} class={route.page === p.id ? "active" : ""} aria-current={route.page === p.id ? "page" : undefined}>
                      {p.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <button
          class="link rail-logout"
          onClick={async () => {
            await api("POST", "/logout").catch(() => undefined);
            setAuth("out");
          }}
        >
          로그아웃
        </button>
      </aside>
      <main class="content">
        <header class="page-head">
          <h1>{current.label}</h1>
          <p class="muted">{current.desc}</p>
        </header>
        {current.view(route.arg)}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
