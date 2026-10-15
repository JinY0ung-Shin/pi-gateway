import { execFileSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertCommandBody } from "../../src/plugins/commands.js";
import { discoverComponents } from "../../src/plugins/components.js";
import { parseMarkdownFrontmatter } from "../../src/plugins/frontmatter.js";
import { normalizeGitUrl } from "../../src/plugins/git.js";
import { parseJsonLenient } from "../../src/plugins/manifest.js";
import { parseMarketplaceManifest } from "../../src/plugins/marketplace.js";
import { convertClaudeVariables } from "../../src/plugins/mcp-mapping.js";
import { readContainedFile, safeCopyTree } from "../../src/plugins/safe-copy.js";
import { PluginService } from "../../src/plugins/service.js";
import {
  adminHeaders,
  BROKER_STDIO_FIXTURE,
  brokerEnv,
  buildHarness,
  callBrokerTool,
  captureLogger,
  cleanupTempDirs,
  dbFilesContain,
  type FakeBroker,
  git,
  type Harness,
  startFakeBroker,
  startFakeTestBroker,
  startRealBroker,
  type TestBroker,
  tempDir,
  testBrokerEnv,
} from "./helpers.js";

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function treeHasSymlink(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && treeHasSymlink(join(dir, entry.name))) return true;
  }
  return false;
}

/** 디렉토리 아래 어떤 파일에든 문자열이 있는지 (심볼릭 링크는 따라가지 않는다) */
function treeContains(dir: string, needle: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && treeContains(path, needle)) return true;
    if (entry.isFile() && readFileSync(path).includes(Buffer.from(needle))) return true;
  }
  return false;
}

function commitAll(repo: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return git(repo, "rev-parse", "HEAD").trim();
}

/** 실제 defect-agent-frontend 1.9.0 레이아웃을 흉내 낸 marketplace (+ 위험한 항목들) */
function buildFixture(root: string) {
  const marker = join(root, "EXECUTED");
  const secretFile = join(root, "outside-secret.txt");
  writeFileSync(secretFile, "TOP-SECRET-OUTSIDE-CONTENT");

  // 원격 저장소 (url / git-subdir source)
  const remote = join(root, "remote");
  mkdirSync(remote);
  git(remote, "init", "-q");
  write(remote, ".claude-plugin/plugin.json", JSON.stringify({ name: "remote" }));
  write(remote, "skills/r/SKILL.md", "---\nname: r\ndescription: Remote skill\n---\nbody");
  write(remote, "nested/tool/.claude-plugin/plugin.json", JSON.stringify({ name: "subdir", version: "2.0.0" }));
  write(remote, "nested/tool/skills/t/SKILL.md", "---\nname: t\ndescription: Subdir skill\n---\nbody");
  const remoteSha = commitAll(remote);

  const mkt = join(root, "mkt");
  mkdirSync(mkt);
  git(mkt, "init", "-q");
  write(
    mkt,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "defect-agent-plugins",
      owner: { name: "monsemi" },
      plugins: [
        { name: "defect-agent-frontend", source: "./plugins/defect-agent-frontend", description: "MonSemi UI" },
        { name: "secret-tools", source: "./plugins/secret-tools" },
        { name: "evil", source: "./plugins/evil" },
        { name: "escape", source: "./../outside" },
        { name: "remote", source: { source: "url", url: remote, sha: remoteSha } },
        { name: "subdir", source: { source: "git-subdir", url: remote, path: "nested/tool" } },
        { name: "npm-thing", source: { source: "npm", package: "x" } },
        { bad: true },
      ],
    }),
  );

  const daf = "plugins/defect-agent-frontend";
  write(
    mkt,
    `${daf}/.claude-plugin/plugin.json`,
    JSON.stringify({
      name: "defect-agent-frontend",
      version: "1.9.0",
      description: "Teaches AI agents how to format responses as rich composite UI panels.",
      license: "MIT",
    }),
  );
  write(mkt, `${daf}/.mcp.json`, JSON.stringify({ mcpServers: { "monsemi-frontend": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"] } } }));
  write(
    mkt,
    `${daf}/mcp/server.js`,
    `const SERVICE_URL = process.env.SERVICE_URL || process.env.ORCHESTRATOR_URL || "http://localhost:9000";\n` +
      `const threadId = process.env.THREAD_ID;\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  write(
    mkt,
    `${daf}/skills/composite-ui/SKILL.md`,
    "---\nname: composite-ui\ndescription: >\n  Formats agent responses as rich composite UI panels\n  with 4 atomic element types.\nmetadata:\n  author: monsemi\n---\n# Composite UI\nSee references/chart.md\n",
  );
  write(mkt, `${daf}/skills/composite-ui/references/chart.md`, "Scripts live in ${CLAUDE_PLUGIN_ROOT}/scripts and ${CLAUDE_SKILL_DIR}.\n");
  // 엄격한 YAML이 아니다 (따옴표 없는 콜론)
  write(mkt, `${daf}/skills/ui-state/SKILL.md`, "---\nname: ui-state\ndescription: Read the UI: state and send commands\n---\nbody\n");
  write(mkt, `${daf}/commands/review.md`, "---\ndescription: Review a target\nargument-hint: <target> <focus>\n---\nReview $0 then $1 with $ARGUMENTS\n");
  write(mkt, `${daf}/commands/git/legacy.md`, "Legacy $1 only\n");
  write(mkt, `${daf}/commands/plain.md`, "---\ndescription: Plain\nallowed-tools: Bash(git:*)\n---\nJust do it. !`git status`\n");
  write(mkt, `${daf}/hooks/hooks.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } }));
  write(mkt, `${daf}/agents/helper.md`, "---\nname: helper\n---\nhelp");

  write(
    mkt,
    "plugins/secret-tools/.claude-plugin/plugin.json",
    JSON.stringify({
      name: "secret-tools",
      version: "0.1.0",
      mcpServers: {
        gh: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/gh.js"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG_LEVEL: "${LOG_LEVEL:-info}" } },
        "remote-docs": { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
        "legacy-sse": { type: "sse", url: "https://old.example.com/sse" },
        // 비밀키가 필요한데 실행 시 다운로드하는 명령 → broker가 거절하므로 사전 설치 필요로 기록
        "npx-tool": { command: "npx", args: ["-y", "@example/mcp"], env: { X_TOKEN: "${X_TOKEN}" } },
        // 비밀키가 없으면 sandbox에서 실행 (인터넷이 허용되므로 npx도 동작한다)
        "npx-public": { command: "npx", args: ["-y", "@example/public-mcp"] },
        // 리터럴 자격증명: sandbox로 가면 agent env에 들어가므로 등록하지 않는다
        "literal-tool": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/gh.js"], env: { API_TOKEN: "hardcoded-token-123" } },
      },
    }),
  );
  write(mkt, "plugins/secret-tools/gh.js", "// stub\n");

  write(mkt, "plugins/evil/.claude-plugin/plugin.json", JSON.stringify({ name: "evil", version: "6.6.6" }));
  write(mkt, "plugins/evil/skills/x/SKILL.md", "---\nname: x\ndescription: X\n---\nx");
  symlinkSync(secretFile, join(mkt, "plugins/evil/link-outside"));
  symlinkSync("..", join(mkt, "plugins/evil/link-dir"));
  symlinkSync("skills/x/SKILL.md", join(mkt, "plugins/evil/ok-link.md"));
  mkdirSync(join(root, "outside"));
  const mktSha = commitAll(mkt);
  return { mkt, remote, remoteSha, mktSha, marker };
}

const json = { "content-type": "application/json" };
const TOKEN = "tok-never-store-0123456789";

describe("plugin installer (fixture marketplace)", () => {
  let broker: FakeBroker;
  let h: Harness;
  let fx: ReturnType<typeof buildFixture>;
  const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: payload === undefined ? adminHeaders : { ...adminHeaders, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    fx = buildFixture(tempDir("fixture"));
    broker = await startFakeBroker();
    h = await buildHarness({ env: brokerEnv(broker.url) });
  });
  afterAll(async () => {
    await h?.close();
    await broker?.close();
  });

  it("marketplace를 추가한다 (token은 저장하지 않는다)", async () => {
    const res = await api("POST", "/admin/api/marketplaces", { url: fx.mkt, token: TOKEN });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "defect-agent-plugins", commitSha: fx.mktSha, pluginCount: 7, invalidEntries: 1, owner: "monsemi" });
    expect(dbFilesContain(h.dbPath, TOKEN)).toBe(false);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
    const again = await api("POST", "/admin/api/marketplaces", { url: fx.mkt });
    expect(again.statusCode).toBe(409);

    const detail = (await api("GET", "/admin/api/marketplaces/defect-agent-plugins")).json();
    const byName = Object.fromEntries(detail.plugins.map((p: { name: string }) => [p.name, p]));
    expect(byName["npm-thing"]).toMatchObject({ supported: false, sourceType: "npm" });
    expect(byName["remote"]).toMatchObject({ supported: true, sourceType: "url", installed: null });
  });

  it("defect-agent-frontend: skill·command·sandbox MCP로 바뀌고 plugin 코드는 실행되지 않는다", async () => {
    let res = await api("PUT", "/admin/api/plugin-settings", {
      mcpDefaults: {
        env: { THREAD_ID: "{{metadata:THREAD_ID}}", ORCHESTRATOR_URL: "{{metadata:ORCHESTRATOR_URL}}", SERVICE_URL: "http://orchestrator:9000" },
        scope: "per-user",
      },
    });
    expect(res.statusCode).toBe(200);
    res = await api("PUT", "/admin/api/plugin-settings", { mcpDefaults: { env: { X: "{{secret:A}}" }, scope: "per-session" } });
    expect(res.statusCode).toBe(400);

    const revisionBefore = h.plugins.revision();
    res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "defect-agent-frontend" });
    expect(res.statusCode).toBe(201);
    const { plugin } = res.json();
    // 기록·skill·MCP 인자에는 버전 없는 고정 경로(current 링크)를 쓴다
    const pluginDir = join(h.config.pluginsDir, "defect-agent-plugins", "defect-agent-frontend");
    const root = join(pluginDir, "current");
    expect(plugin).toMatchObject({ id: "defect-agent-frontend@defect-agent-plugins", version: "1.9.0", installPath: root, enabled: true });
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    expect(readlinkSync(root)).toBe("1.9.0");
    expect(lstatSync(join(pluginDir, "1.9.0")).isDirectory()).toBe(true);
    expect(h.plugins.revision()).toBeGreaterThan(revisionBefore);

    const skills = h.plugins.skills();
    expect(skills.map((s) => s.name)).toEqual(["defect-agent-frontend:composite-ui", "defect-agent-frontend:ui-state"]);
    expect(skills[0]).toMatchObject({
      filePath: join(root, "skills/composite-ui/SKILL.md"),
      baseDir: join(root, "skills/composite-ui"),
      disableModelInvocation: false,
    });
    expect(skills[0]!.description).toMatch(/^Formats agent responses/);
    expect(skills[1]!.description).toBe("Read the UI: state and send commands");
    expect(existsSync(skills[0]!.filePath)).toBe(true);
    expect(readFileSync(join(root, "skills/composite-ui/references/chart.md"), "utf8")).toBe(
      `Scripts live in ${root}/scripts and ${join(root, "skills/composite-ui")}.\n`,
    );

    const templates = Object.fromEntries(h.plugins.promptTemplates().map((t) => [t.name, t]));
    expect(templates["defect-agent-frontend:review"]).toMatchObject({
      content: "Review $1 then $2 with $ARGUMENTS\n",
      argumentHint: "<target> <focus>",
      description: "Review a target",
    });
    expect(templates["defect-agent-frontend:git:legacy"]!.content).toBe("Legacy $1 only\n");
    expect(templates["defect-agent-frontend:plain"]!.content).toBe("Just do it. !`git status`\n\nARGUMENTS: $ARGUMENTS");

    const monsemi = h.mcp.sandboxServers().find((s) => s.id === "monsemi-frontend");
    expect(monsemi).toMatchObject({
      runIn: "sandbox",
      scope: "per-session",
      enabled: true,
      transport: {
        type: "stdio",
        command: "node",
        args: [join(root, "mcp/server.js")],
        env: {
          THREAD_ID: "{{metadata:THREAD_ID}}",
          ORCHESTRATOR_URL: "{{metadata:ORCHESTRATOR_URL}}",
          SERVICE_URL: "http://orchestrator:9000",
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: "/workspace/.home/.plugin-data/defect-agent-plugins--defect-agent-frontend",
        },
      },
      source: { kind: "plugin", pluginId: "defect-agent-frontend@defect-agent-plugins", version: "1.9.0" },
    });
    expect(plugin.mcp).toEqual([
      expect.objectContaining({ name: "monsemi-frontend", id: "monsemi-frontend", runIn: "sandbox", status: "registered", requiredSecrets: [] }),
    ]);
    const kinds = plugin.components.unsupported.map((u: { kind: string }) => u.kind);
    expect(kinds).toEqual(expect.arrayContaining(["hooks", "agents"]));
    const plain = plugin.components.commands.find((c: { name: string }) => c.name === "defect-agent-frontend:plain");
    expect(plain.notes.join(" ")).toMatch(/셸 명령 주입/);

    expect(existsSync(fx.marker)).toBe(false);
    expect(statSync(join(root, "skills/composite-ui/SKILL.md")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, "mcp")).mode & 0o777).toBe(0o755);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, ".git"))).toBe(false);
    // marketplace 사본은 sandbox에 보이는 plugins 디렉토리 밖에 있다
    expect(readdirSync(h.config.pluginsDir).filter((n) => !n.startsWith("."))).toEqual(["defect-agent-plugins"]);
  });

  it("secret-tools: 비밀키가 필요한 서버는 broker로, sse는 지원 안 함으로 기록한다", async () => {
    const res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "secret-tools" });
    expect(res.statusCode).toBe(201);
    const { plugin, warnings } = res.json();
    const byName = Object.fromEntries(plugin.mcp.map((m: { name: string }) => [m.name, m]));
    expect(byName.gh).toMatchObject({ runIn: "broker", status: "registered", requiredSecrets: ["GITHUB_TOKEN"] });
    expect(byName["remote-docs"]).toMatchObject({ runIn: "broker", status: "registered", requiredSecrets: ["DOCS_TOKEN"] });
    expect(byName["legacy-sse"]).toMatchObject({ status: "unsupported" });
    expect(byName["npx-tool"]).toMatchObject({ status: "needs_preinstall", runIn: "broker", requiredSecrets: ["X_TOKEN"] });
    expect(byName["npx-tool"].reason).toMatch(/npx -y @example\/mcp/);
    expect(broker.servers.has("npx-tool")).toBe(false);
    expect(byName["npx-public"]).toMatchObject({ status: "registered", runIn: "sandbox" });
    expect(byName["npx-public"].warnings.join(" ")).toMatch(/pre-install/);
    const npxPublic = h.mcp.store.get("npx-public")!;
    expect(npxPublic.scope).toBe("per-user");
    expect(Object.keys((npxPublic.transport as { env: Record<string, string> }).env).sort()).toEqual(["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT"]);
    expect(byName["literal-tool"]).toMatchObject({ status: "error" });
    expect(byName["literal-tool"].reason).toMatch(/API_TOKEN.*literal credential.*runIn=broker/);
    expect(h.mcp.store.get("literal-tool")).toBeUndefined();
    const gh = broker.servers.get("gh");
    expect(gh?.transport).toMatchObject({ env: { GITHUB_TOKEN: "{{secret:GITHUB_TOKEN}}", LOG_LEVEL: "info" } });
    expect(broker.servers.get("remote-docs")?.transport).toMatchObject({ headers: { Authorization: "Bearer {{secret:DOCS_TOKEN}}" } });
    expect(warnings.join("\n")).toMatch(/GITHUB_TOKEN/);
  });

  it("evil: clone은 링크를 링크 경로가 적힌 일반 파일로 받으므로 밖의 내용이 들어오지 않는다", async () => {
    const res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "evil" });
    expect(res.statusCode).toBe(201);
    const { plugin } = res.json();
    const root = plugin.installPath as string;
    for (const name of ["link-outside", "link-dir", "ok-link.md"]) expect(lstatSync(join(root, name)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "link-outside"), "utf8")).not.toContain("TOP-SECRET");
    expect(readFileSync(join(root, "ok-link.md"), "utf8")).toBe("skills/x/SKILL.md");
    expect(treeContains(h.config.pluginsDir, "TOP-SECRET-OUTSIDE-CONTENT")).toBe(false);
    // marketplace 사본(gateway 전용)에도 링크가 없다
    expect(treeHasSymlink(join(h.config.dataDir, "plugin-marketplaces"))).toBe(false);
  });

  it("marketplace.json이 밖을 가리키는 링크여도 내용을 읽거나 오류에 드러내지 않는다", async () => {
    const root = tempDir("mkt-link");
    const secret = join(root, "secret.json");
    writeFileSync(secret, '{"leak": "SECRET-EXCERPT-9f8e7d"');
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    git(repo, "init", "-q");
    symlinkSync(secret, join(repo, ".claude-plugin", "marketplace.json"));
    commitAll(repo);
    const res = await api("POST", "/admin/api/marketplaces", { url: repo });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("SECRET-EXCERPT");
    expect(res.body).not.toContain(secret);
    expect(res.json().error.message).toBe(".claude-plugin/marketplace.json is not valid JSON");
  });

  it("source 검사: 경로 탈출·지원 안 하는 source는 거절한다", async () => {
    let res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "escape" });
    expect(res.statusCode).toBe(400);
    res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "npm-thing" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("unsupported_source");
    res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "nope" });
    expect(res.statusCode).toBe(404);
  });

  it("url(sha 고정)·git-subdir source를 설치한다", async () => {
    let res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "remote" });
    expect(res.statusCode).toBe(201);
    expect(res.json().plugin).toMatchObject({ version: fx.remoteSha.slice(0, 12), source: { type: "url", commit: fx.remoteSha, sha: fx.remoteSha } });
    res = await api("POST", "/admin/api/plugins/install", { marketplace: "defect-agent-plugins", plugin: "subdir" });
    expect(res.statusCode).toBe(201);
    expect(res.json().plugin).toMatchObject({ version: "2.0.0", source: { type: "git-subdir", path: "nested/tool" } });
    expect(h.plugins.skills().map((s) => s.name)).toEqual(expect.arrayContaining(["remote:r", "subdir:t"]));
  });

  it("끄기·켜기·재설치는 skill과 MCP 서버에 반영되고 관리자가 바꾼 env는 유지된다", async () => {
    const id = "defect-agent-frontend@defect-agent-plugins";
    let res = await api("POST", `/admin/api/plugins/${encodeURIComponent(id)}/disable`, {});
    expect(res.statusCode).toBe(200);
    expect(h.plugins.skills().some((s) => s.name.startsWith("defect-agent-frontend:"))).toBe(false);
    expect(h.mcp.sandboxServers().some((s) => s.id === "monsemi-frontend")).toBe(false);
    res = await api("POST", `/admin/api/plugins/${encodeURIComponent(id)}/enable`, {});
    expect(h.plugins.skills().some((s) => s.name.startsWith("defect-agent-frontend:"))).toBe(true);
    expect(h.mcp.sandboxServers().some((s) => s.id === "monsemi-frontend")).toBe(true);

    const current = h.mcp.store.get("monsemi-frontend")!;
    if (current.transport.type !== "stdio") throw new Error("expected stdio");
    await h.mcp.upsert({ ...current, transport: { ...current.transport, env: { ...current.transport.env, SERVICE_URL: "http://other:9000" } } }, "admin");
    res = await api("POST", `/admin/api/plugins/${encodeURIComponent(id)}/update`, {});
    expect(res.statusCode).toBe(200);
    const after = h.mcp.store.get("monsemi-frontend")!;
    expect(after.transport).toMatchObject({ env: { SERVICE_URL: "http://other:9000", THREAD_ID: "{{metadata:THREAD_ID}}" } });
  });

  it("다른 marketplace의 같은 이름 plugin은 설치할 수 없다", async () => {
    const other = tempDir("mkt2");
    git(other, "init", "-q");
    write(other, ".claude-plugin/marketplace.json", JSON.stringify({ name: "other-mkt", plugins: [{ name: "evil", source: "./p" }] }));
    write(other, "p/.claude-plugin/plugin.json", JSON.stringify({ name: "evil" }));
    commitAll(other);
    expect((await api("POST", "/admin/api/marketplaces", { url: other })).statusCode).toBe(201);
    const res = await api("POST", "/admin/api/plugins/install", { marketplace: "other-mkt", plugin: "evil" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("name_conflict");
    expect((await api("DELETE", "/admin/api/marketplaces/other-mkt")).statusCode).toBe(204);
  });

  it("제거: 파일과 MCP 서버를 지우고, plugin이 남은 marketplace는 지울 수 없다", async () => {
    const id = "defect-agent-frontend@defect-agent-plugins";
    expect((await api("DELETE", "/admin/api/marketplaces/defect-agent-plugins")).statusCode).toBe(409);
    let res = await api("DELETE", `/admin/api/plugins/${encodeURIComponent(id)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removedMcpServers).toEqual(["monsemi-frontend"]);
    expect(existsSync(join(h.config.pluginsDir, "defect-agent-plugins", "defect-agent-frontend"))).toBe(false);
    expect(h.mcp.store.get("monsemi-frontend")).toBeUndefined();
    res = await api("DELETE", "/admin/api/plugins/secret-tools%40defect-agent-plugins");
    expect(res.json().removedMcpServers.sort()).toEqual(["gh", "npx-public", "remote-docs"]);
    expect(broker.servers.size).toBe(0);
    for (const name of ["evil", "remote", "subdir"]) {
      expect((await api("DELETE", `/admin/api/plugins/${name}%40defect-agent-plugins`)).statusCode).toBe(200);
    }
    expect(h.plugins.skills()).toEqual([]);
    expect((await api("DELETE", "/admin/api/marketplaces/defect-agent-plugins")).statusCode).toBe(204);
    expect((await api("GET", "/admin/api/marketplaces")).json().marketplaces).toEqual([]);
  });
});

describe("plugin 업데이트·broker 장애", () => {
  const ID = "defect-agent-frontend@defect-agent-plugins";
  const daf = "plugins/defect-agent-frontend";
  const setMcp = (repo: string, version: string, env: Record<string, string>) => {
    write(repo, `${daf}/.claude-plugin/plugin.json`, JSON.stringify({ name: "defect-agent-frontend", version }));
    write(repo, `${daf}/.mcp.json`, JSON.stringify({ mcpServers: { "monsemi-frontend": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"], env } } }));
    commitAll(repo);
  };

  it("업데이트: plugin이 바꾼 env는 반영하고 관리자가 넣은 값은 유지한다", async () => {
    const fixture = buildFixture(tempDir("fixture-update"));
    setMcp(fixture.mkt, "1.9.0", { LOG_FORMAT: "json" });
    const harness = await buildHarness();
    try {
      await harness.plugins.addMarketplace({ url: fixture.mkt }, "t");
      await harness.plugins.install({ marketplace: "defect-agent-plugins", plugin: "defect-agent-frontend" }, "t");
      const current = harness.mcp.store.get("monsemi-frontend")!;
      if (current.transport.type !== "stdio") throw new Error("stdio expected");
      await harness.mcp.upsert({ ...current, transport: { ...current.transport, env: { ...current.transport.env, SERVICE_URL: "http://admin:9000" } } }, "admin");

      setMcp(fixture.mkt, "1.9.1", { LOG_FORMAT: "text" });
      await harness.plugins.refreshMarketplace("defect-agent-plugins", {}, "t");
      const { plugin } = await harness.plugins.update(ID, {}, "t");
      expect(plugin.version).toBe("1.9.1");
      const after = harness.mcp.store.get("monsemi-frontend")!;
      expect(after.transport).toMatchObject({
        args: [join(plugin.installPath, "mcp/server.js")],
        env: { LOG_FORMAT: "text", SERVICE_URL: "http://admin:9000", CLAUDE_PLUGIN_ROOT: plugin.installPath, THREAD_ID: "{{metadata:THREAD_ID}}" },
      });
      expect(after.scope).toBe("per-session");
    } finally {
      await harness.close();
    }
  });

  it("broker가 안 되면 끄기·제거·업데이트가 503이고 plugin과 broker 서버는 그대로다", async () => {
    const broker = await startFakeBroker();
    const fixture = buildFixture(tempDir("fixture-down"));
    const harness = await buildHarness({ env: brokerEnv(broker.url) });
    const sid = "secret-tools@defect-agent-plugins";
    try {
      await harness.plugins.addMarketplace({ url: fixture.mkt }, "t");
      await harness.plugins.install({ marketplace: "defect-agent-plugins", plugin: "secret-tools" }, "t");
      expect(broker.servers.has("gh")).toBe(true);
      broker.setDown(true);
      await expect(harness.plugins.setEnabled(sid, false, "t")).rejects.toMatchObject({ status: 503 });
      expect(harness.plugins.getPlugin(sid).enabled).toBe(true);
      await expect(harness.plugins.uninstall(sid, "t")).rejects.toMatchObject({ status: 503 });
      expect(harness.plugins.getPlugin(sid).version).toBe("0.1.0");
      await expect(harness.plugins.update(sid, {}, "t")).rejects.toMatchObject({ status: 503 });
      broker.setDown(false);
      expect(broker.servers.get("gh")?.enabled).toBe(true);
      const removed = await harness.plugins.uninstall(sid, "t");
      expect(removed.removedMcpServers).toContain("gh");
      expect(broker.servers.has("gh")).toBe(false);
    } finally {
      broker.setDown(false);
      await harness.close();
      await broker.close();
    }
  });

  for (const kind of ["fake", "real"] as const) {
    it(`업데이트해도 broker 서버의 실행 대상(current 경로)이 그대로라 비밀키가 남고, 오래된 버전만 정리된다 (${kind} broker)`, async () => {
      const fake = kind === "fake" ? await startFakeTestBroker() : undefined;
      const broker: TestBroker = fake ?? (await startRealBroker());
      const fixture = buildFixture(tempDir(`fixture-keep-${kind}`));
      if (kind === "real") {
        // 실제 broker가 current 링크를 거쳐 서버를 띄우는지도 본다
        writeFileSync(join(fixture.mkt, "plugins/secret-tools/gh.js"), readFileSync(BROKER_STDIO_FIXTURE));
        commitAll(fixture.mkt);
      }
      const harness = await buildHarness({ env: testBrokerEnv(broker) });
      const sid = "secret-tools@defect-agent-plugins";
      const bump = (version: string) => {
        const file = join(fixture.mkt, "plugins/secret-tools/.claude-plugin/plugin.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), version }));
        commitAll(fixture.mkt);
      };
      try {
        await harness.plugins.addMarketplace({ url: fixture.mkt }, "t");
        const first = await harness.plugins.install({ marketplace: "defect-agent-plugins", plugin: "secret-tools" }, "t");
        const pluginDir = dirname(first.plugin.installPath);
        const stableArgs = [join(pluginDir, "current", "gh.js")];
        expect((await harness.mcp.get("gh")).config.transport).toMatchObject({ args: stableArgs });
        await harness.mcp.setSecret("gh", "GITHUB_TOKEN", { value: "ghp_kept_across_updates" }, "admin");
        const secretsBefore = (await harness.mcp.get("gh")).secrets;
        expect(secretsBefore?.map((s) => s.name)).toEqual(["GITHUB_TOKEN"]);
        for (const version of ["0.1.1", "0.1.2"]) {
          bump(version);
          await harness.plugins.refreshMarketplace("defect-agent-plugins", {}, "t");
          const { plugin, warnings } = await harness.plugins.update(sid, {}, "t");
          expect(plugin.version).toBe(version);
          expect(readlinkSync(join(pluginDir, "current"))).toBe(version);
          expect(warnings.join("\n")).not.toMatch(/GITHUB_TOKEN/);
        }
        const gh = await harness.mcp.get("gh");
        expect(gh.config.transport).toMatchObject({ args: stableArgs });
        expect(gh.missingSecrets).toEqual([]);
        // 다시 넣은 값이 아니라 처음 넣은 값이 그대로 남았다 (setAt·fingerprint가 같다)
        expect(gh.secrets).toEqual(secretsBefore);
        if (fake) expect(fake.fake.secrets.get("gh")?.get("GITHUB_TOKEN")).toBe("ghp_kept_across_updates");
        // 현재와 바로 이전 버전만 남는다
        expect(readdirSync(pluginDir).filter((n) => !n.startsWith(".")).sort()).toEqual(["0.1.1", "0.1.2", "current"]);
        if (kind === "real") {
          const result = await callBrokerTool(broker, "gh", "whoami");
          expect(result.isError).toBeFalsy();
        }
      } finally {
        await harness.close();
        await broker.close();
      }
    });
  }

  it("broker가 안 돼도 sandbox 전용 plugin은 설치·끄기·켜기·업데이트·제거가 되고, 설치 뒤로는 broker에 묻지 않는다", async () => {
    const broker = await startFakeBroker();
    const fixture = buildFixture(tempDir("fixture-sbx-down"));
    const harness = await buildHarness({ env: brokerEnv(broker.url) });
    try {
      await harness.plugins.addMarketplace({ url: fixture.mkt }, "t");
      broker.setDown(true);
      // 새 id는 broker 서버와 겹치는지 묻고, 안 되면 기억한 broker id 목록으로 판단한다
      await harness.plugins.install({ marketplace: "defect-agent-plugins", plugin: "defect-agent-frontend" }, "t");
      expect(harness.mcp.store.get("monsemi-frontend")).toBeDefined();
      const asked = broker.refused.length;
      expect(asked).toBeGreaterThan(0);
      await harness.plugins.setEnabled(ID, false, "t");
      expect(harness.mcp.sandboxServers().some((s) => s.id === "monsemi-frontend")).toBe(false);
      await harness.plugins.setEnabled(ID, true, "t");
      const manifest = join(fixture.mkt, "plugins/defect-agent-frontend/.claude-plugin/plugin.json");
      writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "1.9.1" }));
      commitAll(fixture.mkt);
      await harness.plugins.refreshMarketplace("defect-agent-plugins", {}, "t");
      expect((await harness.plugins.update(ID, {}, "t")).plugin.version).toBe("1.9.1");
      expect(harness.mcp.store.get("monsemi-frontend")?.enabled).toBe(true);
      const removed = await harness.plugins.uninstall(ID, "t");
      expect(removed.removedMcpServers).toEqual(["monsemi-frontend"]);
      expect(broker.refused.length).toBe(asked);
    } finally {
      broker.setDown(false);
      await harness.close();
      await broker.close();
    }
  });
});

describe("plugin 설치 권한 (gateway는 umask 077로 돈다)", () => {
  it("설치본과 상위 디렉토리는 sandbox(uid 1000)·broker가 읽을 수 있다", async () => {
    const fixture = buildFixture(tempDir("fixture-umask"));
    const harness = await buildHarness();
    const previous = process.umask(0o077);
    try {
      await harness.plugins.addMarketplace({ url: fixture.mkt }, "t");
      const { plugin } = await harness.plugins.install({ marketplace: "defect-agent-plugins", plugin: "defect-agent-frontend" }, "t");
      const bad: string[] = [];
      const walk = (path: string) => {
        const info = lstatSync(path);
        const mode = info.mode & 0o777;
        if (info.isDirectory()) {
          if (mode !== 0o755) bad.push(`${path} ${mode.toString(8)}`);
          for (const name of readdirSync(path)) walk(join(path, name));
        } else if (mode !== 0o644 && mode !== 0o755) bad.push(`${path} ${mode.toString(8)}`);
      };
      // installPath는 current 링크다. 실제 버전 디렉토리를 검사하고, 링크가 그 버전을 가리키는지 본다.
      expect(lstatSync(plugin.installPath).isSymbolicLink()).toBe(true);
      walk(realpathSync(plugin.installPath));
      for (const dir of [
        harness.config.pluginsDir,
        join(harness.config.pluginsDir, "defect-agent-plugins"),
        join(harness.config.pluginsDir, "defect-agent-plugins", "defect-agent-frontend"),
      ]) {
        const mode = statSync(dir).mode & 0o777;
        if (mode !== 0o755) bad.push(`${dir} ${mode.toString(8)}`);
      }
      expect(bad).toEqual([]);
    } finally {
      process.umask(previous);
      await harness.close();
    }
  });
});

describe("plugin helpers", () => {
  it("git URL 검사: 자격증명·SSH·ext·로컬 경로(허용 안 할 때)를 거절한다", () => {
    expect(normalizeGitUrl("JinY0ung-Shin/MonSemi", false)).toBe("https://github.com/JinY0ung-Shin/MonSemi.git");
    expect(normalizeGitUrl("https://git.example.com/a/b.git", false)).toBe("https://git.example.com/a/b.git");
    expect(() => normalizeGitUrl("https://user:pass@github.com/a/b.git", false)).toThrow(/credentials/);
    expect(() => normalizeGitUrl("git@github.com:a/b.git", false)).toThrow(/SSH/);
    expect(() => normalizeGitUrl("ext::sh -c touch% /tmp/pwned", false)).toThrow();
    expect(() => normalizeGitUrl("/srv/repo", false)).toThrow(/local/);
    expect(() => normalizeGitUrl("file:///srv/repo", false)).toThrow();
    expect(normalizeGitUrl("/srv/repo", true)).toBe("/srv/repo");
  });

  it("command 변환: 0-based $N, $ARGUMENTS[N], 이름 인자, 자리표시자 없음", () => {
    expect(convertCommandBody("a $0 b $1 c $ARGUMENTS[0]").content).toBe("a $1 b $2 c $1");
    expect(convertCommandBody("legacy $1 $2").content).toBe("legacy $1 $2");
    expect(convertCommandBody("deploy $env to $region", ["env", "region"]).content).toBe("deploy $1 to $2");
    expect(convertCommandBody("no args").content).toBe("no args\n\nARGUMENTS: $ARGUMENTS");
    expect(convertCommandBody("price $$0 and \\$0").content).toContain("$$0");
  });

  it("frontmatter: 엄격하지 않은 YAML도 읽는다", () => {
    const parsed = parseMarkdownFrontmatter("---\nname: a\ndescription: has: colon\nwhen_to_use: >\n  multi\n  line\n---\nbody");
    expect(parsed.lenient).toBe(true);
    expect(parsed.frontmatter).toMatchObject({ name: "a", description: "has: colon", when_to_use: "multi line" });
    expect(parsed.body).toBe("body");
    expect(parseMarkdownFrontmatter("no frontmatter").frontmatter).toEqual({});
  });

  it("Claude 변수 변환: 비밀로 보이는 변수는 {{secret}}, 기본값 있는 일반 변수는 기본값", () => {
    const ctx = { root: "/opt/plugins/m/p/1", dataDir: "/workspace/.home/.plugin-data/m--p" };
    expect(convertClaudeVariables("${CLAUDE_PLUGIN_ROOT}/x ${CLAUDE_PLUGIN_DATA}", ctx)).toBe("/opt/plugins/m/p/1/x /workspace/.home/.plugin-data/m--p");
    expect(convertClaudeVariables("${API_TOKEN:-abc} ${PORT:-3000} ${HOST} ${user_config.key}", ctx)).toBe(
      "{{secret:API_TOKEN}} 3000 {{secret:HOST}} {{secret:user_config.key}}",
    );
  });

  it("경계 안 읽기: 링크·밖을 가리키는 디렉토리·경로 탈출·큰 파일을 거절하고 오류에 상대 경로만 넣는다", async () => {
    const root = tempDir("contained");
    const outside = tempDir("contained-outside");
    writeFileSync(join(outside, "secret.json"), "SECRET");
    mkdirSync(join(root, ".claude-plugin"));
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"name":"ok"}');
    symlinkSync(join(outside, "secret.json"), join(root, "link.json"));
    symlinkSync(outside, join(root, "dirlink"));
    writeFileSync(join(root, "big.json"), "x".repeat(2048));
    expect(await readContainedFile(root, ".claude-plugin/plugin.json")).toBe('{"name":"ok"}');
    expect(await readContainedFile(root, "missing.json", { optional: true })).toBeUndefined();
    await expect(readContainedFile(root, "link.json")).rejects.toMatchObject({ code: "symlink_refused", message: "link.json must not be a symbolic link" });
    await expect(readContainedFile(root, "dirlink/secret.json")).rejects.toMatchObject({ code: "outside_repository" });
    await expect(readContainedFile(root, "../x.json")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(readContainedFile(root, "big.json", { maxBytes: 1024 })).rejects.toMatchObject({ code: "plugin_too_large" });
    for (const p of [readContainedFile(root, "link.json"), readContainedFile(root, "dirlink/secret.json")]) {
      const error = await p.catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain(outside);
    }
  });

  it("JSON 오류 메시지에는 입력 일부가 들어가지 않는다", () => {
    expect(() => parseJsonLenient('{"a": "SECRET-EXCERPT', "x/plugin.json")).toThrow(/^x\/plugin\.json is not valid JSON$/);
  });

  it("staging의 링크된 SKILL.md는 건너뛰고, 링크된 .mcp.json·밖을 가리키는 mcpServers 파일은 설치를 거절한다", async () => {
    const outside = tempDir("staging-outside");
    writeFileSync(join(outside, "SKILL.md"), "---\nname: stolen\ndescription: outside\n---\n");
    writeFileSync(join(outside, "servers.json"), '{"mcpServers":{}}');
    const entry = parseMarketplaceManifest({ name: "m", plugins: [{ name: "p", source: "./p" }] }).plugins[0]!;
    const make = () => {
      const staging = tempDir("staging");
      mkdirSync(join(staging, "skills", "ok"), { recursive: true });
      writeFileSync(join(staging, "skills", "ok", "SKILL.md"), "---\nname: ok\ndescription: fine\n---\n");
      mkdirSync(join(staging, "skills", "evil"));
      symlinkSync(join(outside, "SKILL.md"), join(staging, "skills", "evil", "SKILL.md"));
      return staging;
    };
    const base = { finalDir: "/opt/plugins/m/p/1", pluginName: "p", manifest: undefined, entry, dataDir: "/d" };

    const found = await discoverComponents({ ...base, stagingDir: make() });
    expect(found.skills.map((s) => s.name)).toEqual(["p:ok"]);
    expect(found.warnings.join("\n")).toMatch(/skills\/evil\/SKILL\.md must not be a symbolic link; skipped/);

    const withMcpLink = make();
    symlinkSync(join(outside, "servers.json"), join(withMcpLink, ".mcp.json"));
    await expect(discoverComponents({ ...base, stagingDir: withMcpLink })).rejects.toMatchObject({ code: "symlink_refused" });

    const withDirLink = make();
    symlinkSync(outside, join(withDirLink, "conf"));
    await expect(
      discoverComponents({ ...base, stagingDir: withDirLink, manifest: { name: "p", mcpServers: "./conf/servers.json" } }),
    ).rejects.toMatchObject({ code: "outside_repository" });
  });

  it("로컬 복사도 링크를 막는다: 밖·디렉토리 링크는 건너뛰고 안쪽 파일 링크는 내용을 복사한다", async () => {
    const src = tempDir("copy-links");
    const outside = tempDir("copy-links-outside");
    writeFileSync(join(outside, "secret"), "TOP-SECRET");
    writeFileSync(join(src, "real.md"), "inside");
    symlinkSync(join(outside, "secret"), join(src, "out-link"));
    symlinkSync(outside, join(src, "dir-link"));
    symlinkSync(".", join(src, "self-link"));
    symlinkSync("real.md", join(src, "in-link.md"));
    const dest = join(tempDir("copy-links-dest"), "out");
    const result = await safeCopyTree(src, dest);
    expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({
      "dir-link": "symlink points outside the plugin",
      "out-link": "symlink points outside the plugin",
      "self-link": "symlink to a directory or special file",
    });
    expect(readFileSync(join(dest, "in-link.md"), "utf8")).toBe("inside");
    expect(lstatSync(join(dest, "in-link.md")).isSymbolicLink()).toBe(false);
  });

  it("안전 복사: FIFO·하드 링크를 건너뛰고 제한을 넘으면 실패한다", async () => {
    const src = tempDir("copy-src");
    const outside = tempDir("copy-outside");
    writeFileSync(join(outside, "secret"), "s");
    writeFileSync(join(src, "a.txt"), "hello");
    writeFileSync(join(src, "run.sh"), "#!/bin/sh\n");
    execFileSync("chmod", ["700", join(src, "run.sh")]);
    execFileSync("mkfifo", [join(src, "pipe")]);
    linkSync(join(outside, "secret"), join(src, "hard"));
    const dest = join(tempDir("copy-dest"), "out");
    const result = await safeCopyTree(src, dest);
    expect(result.files).toBe(2);
    expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({ hard: "hard-linked file", pipe: "special file" });
    expect(statSync(join(dest, "run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "a.txt")).mode & 0o777).toBe(0o644);
    await expect(safeCopyTree(src, join(tempDir("copy-dest2"), "out"), { maxFiles: 1, maxTotalBytes: 1e9, maxFileBytes: 1e9, maxDepth: 5 })).rejects.toMatchObject({
      code: "plugin_too_large",
    });
  });
});

afterAll(cleanupTempDirs);
