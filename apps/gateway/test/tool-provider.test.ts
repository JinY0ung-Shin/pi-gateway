import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOXD_ROUTES } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWordCountProvider } from "./examples/word-count-provider.js";
import { type Harness, ofType, startHarness } from "./helpers.js";

/**
 * 새 ToolProvider 테스트 템플릿 (docs/EXTENDING.md).
 * 1. provider를 기본 목록 뒤에 붙인 gateway를 띄운다 (가짜 LLM, 가짜 sandboxd).
 * 2. 가짜 LLM이 도구를 호출하게 하고, SSE 결과와 sandbox에 간 요청을 확인한다.
 */

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ overrides: { toolProviders: (defaults) => [...defaults, createWordCountProvider()] } });
});
afterAll(async () => {
  await h.close();
});

describe("example ToolProvider (word_count)", () => {
  it("is offered to the model and listed in the catalog", async () => {
    const before = h.llm.requests.length;
    await h.post({ input: "hi" });
    expect((h.llm.requests[before]!.tools ?? []).map((t) => t.function.name)).toContain("word_count");
    const catalog = await h.gateway.tools.list();
    expect(catalog).toContainEqual(expect.objectContaining({ name: "word_count", provider: "word-count", runsIn: "sandbox" }));
  });

  it("runs inside the sandbox", async () => {
    writeFileSync(join(h.sandbox.workspaceOf("alice"), "poem.txt"), "one two\nthree\n");
    h.llm.enqueue({ toolCalls: [{ id: "wc1", name: "word_count", arguments: { path: "poem.txt" } }] }, { text: "done" });
    const res = await h.stream({ input: "count" });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(false);
    expect(String(result.content)).toMatch(/2\s+3\s+14/);
    const exec = h.sandbox.calls.find((c) => c.route === SANDBOXD_ROUTES.exec && (c.body.argv as string[])[0] === "wc");
    expect(exec?.body.argv).toEqual(["wc", "--", "/workspace/poem.txt"]);
  });
});
