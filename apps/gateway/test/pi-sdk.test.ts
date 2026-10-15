import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { type FakeLlm, startFakeLlm } from "./fixtures/fake-llm.js";

process.env.PI_OFFLINE = "1";

let llm: FakeLlm;
beforeAll(async () => {
  llm = await startFakeLlm();
});
afterAll(async () => {
  await llm.close();
});

function loader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => ["Current user: alice"],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

// pi SDK가 gateway가 기대하는 대로 동작하는지 확인한다 (pi 버전을 올릴 때 먼저 깨지는 테스트).
describe("pi SDK contract", () => {
  it("custom provider + terminate tool + events", async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("upstream", {
      baseUrl: llm.url,
      api: "openai-completions",
      models: [
        {
          id: "m1",
          name: "m1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 4096,
          compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
        },
      ],
    });
    await runtime.setRuntimeApiKey("upstream", "k");
    const model = runtime.getModel("upstream", "m1");
    expect(model).toBeDefined();

    const ask: ToolDefinition = {
      name: "AskUserQuestion",
      label: "AskUserQuestion",
      description: "Ask the user",
      parameters: Type.Object({ q: Type.String() }),
      executionMode: "sequential",
      async execute() {
        return { content: [{ type: "text", text: "asked" }], details: undefined, terminate: true };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "pi-probe-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const { session } = await createAgentSession({
      cwd: "/workspace",
      agentDir: dir,
      model: model!,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader("You are a test agent."),
      tools: ["AskUserQuestion"],
      customTools: [ask],
      sessionManager: SessionManager.inMemory("/workspace"),
      settingsManager: SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: true } }, { projectTrusted: false }),
    });
    const events: string[] = [];
    session.subscribe((e) => {
      events.push(e.type === "message_update" ? `update:${e.assistantMessageEvent.type}` : e.type);
    });
    llm.enqueue({ text: "Let me ask.", toolCalls: [{ name: "AskUserQuestion", arguments: { q: "which?" } }] });
    await session.prompt("hello");
    expect(llm.requests.length).toBe(1); // terminate → 추가 LLM 호출 없음
    const sys = llm.requests[0]!.messages[0]!;
    expect(sys.role).toBe("system");
    expect(String(sys.content)).toContain("You are a test agent.");
    expect(String(sys.content)).toContain("Current user: alice");
    expect(events).toContain("tool_execution_start");
    expect(events.at(-1)).toBe("agent_settled");
    session.dispose();
  });
});
