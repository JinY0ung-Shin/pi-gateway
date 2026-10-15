import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { Type } from "typebox";
import type { ToolCatalogEntry } from "../../src/contracts.js";
import { staticEntryLookup, type ToolProvider } from "../../src/tools/provider.js";
import { resolveSandboxPath } from "../../src/tools/remote-fs.js";

/**
 * 예시 ToolProvider (docs/EXTENDING.md). sandbox 안에서 `wc`를 실행하는 word_count 도구 하나.
 * 사용자 파일을 다루므로 규칙 1에 따라 gateway가 아니라 sandbox에서 실행한다.
 */

const ENTRIES: ToolCatalogEntry[] = [
  { name: "word_count", description: "파일의 줄·단어·바이트 수", provider: "word-count", runsIn: "sandbox", enabledByDefault: true },
];

const Params = Type.Object({ path: Type.String({ description: "File path, relative to /workspace" }) });

export function createWordCountProvider(): ToolProvider {
  return {
    id: "word-count",
    description: "예시: sandbox에서 wc를 실행한다",
    catalog: async () => ENTRIES,
    entryFor: staticEntryLookup(ENTRIES),
    async createTools(ctx) {
      const tool: ToolDefinition<typeof Params> = {
        name: "word_count",
        label: "word count",
        description: "Count the lines, words and bytes of a file in the workspace.",
        parameters: Params,
        async execute(_toolCallId, params, signal) {
          const output: Buffer[] = [];
          const result = await ctx.sandbox.exec(
            { argv: ["wc", "--", resolveSandboxPath(params.path, SANDBOX_WORKSPACE)] },
            { onStdout: (c) => output.push(c), onStderr: (c) => output.push(c), ...(signal ? { signal } : {}) },
          );
          const text = Buffer.concat(output).toString("utf8").trim();
          // 실패는 던지지 말고 isError로 돌려준다 (모델이 오류 내용을 보고 다시 시도할 수 있다).
          if (result.exitCode !== 0) return { content: [{ type: "text", text: text || `wc exited with ${result.exitCode}` }], details: undefined, isError: true };
          return { content: [{ type: "text", text }], details: undefined };
        },
      };
      return [tool as unknown as ToolDefinition];
    },
  };
}
