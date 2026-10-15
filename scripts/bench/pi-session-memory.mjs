// 한 Node 프로세스 안에서 pi AgentSession 하나가 쓰는 메모리를 잰다 (LLM 호출 없음).
//
// 저장소에서:          node --expose-gc scripts/bench/pi-session-memory.mjs
// 운영 gateway 컨테이너에서 (같은 pi 버전·Node로 측정):
//   docker compose exec -T gateway node --expose-gc --input-type=module - < scripts/bench/pi-session-memory.mjs
//
// 결과: 프로세스 기본 RSS(한 번만 드는 비용)와 대화 기록 크기별 세션당 증가분. 정리(dispose) 뒤 반환되는지도 본다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (typeof global.gc !== "function") {
  console.error("run with --expose-gc");
  process.exit(2);
}

const pi = await import("@earendil-works/pi-coding-agent");
const { getModel } = await import("@earendil-works/pi-ai/compat");
const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");

const MB = (b) => (b / 1024 / 1024).toFixed(2);
const mem = () => {
  for (let i = 0; i < 4; i++) global.gc();
  return process.memoryUsage();
};

const scratch = mkdtempSync(join(tmpdir(), "pi-bench-"));
const agentDir = join(scratch, "agent");
const ws = "/workspace";

const m0 = mem();
const modelRuntime = await pi.ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  allowModelNetwork: false,
});
await modelRuntime.setRuntimeApiKey("anthropic", "sk-bench-not-used");
const model = getModel("anthropic", "claude-sonnet-4-5");
const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a helpful agent. ".repeat(200),
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
const m1 = mem();
console.log(`process: rss=${MB(m1.rss)}MB heapUsed=${MB(m1.heapUsed)}MB (runtime creation +${MB(m1.rss - m0.rss)}MB)`);

const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// 한국어 텍스트(2바이트 문자열)도 섞어서 실제에 가깝게 만든다
const txt = (n, seed) => `${seed} 로그 분석 결과 lorem ipsum dolor sit amet `.repeat(Math.ceil(n / 40)).slice(0, n);
function appendTurns(sm, turns, toolOut) {
  let t = Date.now();
  for (let i = 0; i < turns; i++) {
    sm.appendMessage({ role: "user", content: txt(300, `u${i}`), timestamp: t++ });
    const id = `call_${i}`;
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: txt(600, `a${i}`) }, { type: "toolCall", id, name: "bash", arguments: { command: `ls -la dir${i}` } }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: t++,
    });
    sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: txt(toolOut, `r${i}`) }], isError: false, timestamp: t++ });
    sm.appendMessage({
      role: "assistant", content: [{ type: "text", text: txt(800, `f${i}`) }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: t++,
    });
  }
}

async function scenario(id, label, turns, toolOut, n) {
  const before = mem();
  const sessions = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const sm = pi.SessionManager.inMemory(ws, { id: `bench-${id}-${i}` });
    appendTurns(sm, turns, toolOut);
    if (i === 0) bytes = sm.getEntries().reduce((s, e) => s + JSON.stringify(e).length, 0);
    const { session } = await pi.createAgentSession({
      cwd: ws, agentDir, model, thinkingLevel: "off", modelRuntime, resourceLoader,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      sessionManager: sm,
      settingsManager: pi.SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: true } }, { projectTrusted: false }),
    });
    sessions.push(session);
  }
  const after = mem();
  const per = (k) => MB((after[k] - before[k]) / n);
  console.log(`[${label}] 기록≈${(bytes / 1024).toFixed(0)}KB/세션, 세션당: rss +${per("rss")}MB heapUsed +${per("heapUsed")}MB`);
  for (const s of sessions) {
    await s.abort();
    s.dispose();
  }
  sessions.length = 0;
  const released = mem();
  console.log(`[${label}] ${n}개 정리 후 heapUsed ${MB(released.heapUsed)}MB (정리 전 ${MB(after.heapUsed)}MB)`);
}

await scenario("empty", "빈 세션", 0, 0, 30);
await scenario("t20", "20턴", 20, 3000, 30);
await scenario("t100", "100턴", 100, 8000, 10);
const end = mem();
console.log(`final: rss=${MB(end.rss)}MB heapUsed=${MB(end.heapUsed)}MB`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
