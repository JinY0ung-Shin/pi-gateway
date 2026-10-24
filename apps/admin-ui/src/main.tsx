import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import { Notice } from "./components";
import { AgentsPage, SkillsPage, ToolsPage } from "./pages/Catalog";
import { ChatPage } from "./pages/Chat";
import { LlmPage } from "./pages/Llm";
import { Login } from "./pages/Login";
import { McpPage } from "./pages/Mcp";
import { PluginsPage } from "./pages/Plugins";
import { PromptsPage } from "./pages/Prompts";
import { StatusPage } from "./pages/Status";
import "./styles.css";

const PAGES = [
  { id: "llm", label: "LLM" },
  { id: "prompts", label: "프롬프트" },
  { id: "tools", label: "도구" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "skill" },
  { id: "agents", label: "agent" },
  { id: "plugins", label: "plugin" },
  { id: "status", label: "상태" },
  { id: "chat", label: "채팅 테스트" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function parseHash(): { page: PageId; arg?: string } {
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

  return (
    <div class="layout">
      <header class="topbar">
        <strong class="brand">pi-gateway 관리</strong>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} class={route.page === p.id ? "active" : ""}>
              {p.label}
            </a>
          ))}
        </nav>
        <button
          class="link"
          onClick={async () => {
            await api("POST", "/logout").catch(() => undefined);
            setAuth("out");
          }}
        >
          로그아웃
        </button>
      </header>
      <main class="content">
        {route.page === "llm" && <LlmPage />}
        {route.page === "prompts" && <PromptsPage />}
        {route.page === "mcp" && <McpPage focus={route.arg} />}
        {route.page === "tools" && <ToolsPage focus={route.arg} />}
        {route.page === "skills" && <SkillsPage focus={route.arg} />}
        {route.page === "agents" && <AgentsPage focus={route.arg} />}
        {route.page === "plugins" && <PluginsPage />}
        {route.page === "status" && <StatusPage />}
        {route.page === "chat" && <ChatPage />}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
