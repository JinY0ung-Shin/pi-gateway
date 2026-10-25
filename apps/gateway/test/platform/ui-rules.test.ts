import { findLiteralCredentials, McpServerConfig } from "@pi-gateway/shared";
import { describe, expect, it } from "vitest";
import { clearsSecrets, literalCredentials } from "../../../admin-ui/src/mcp-rules.js";
import { transportTarget } from "../../../mcp-broker/src/store.js";

/** 관리 화면이 저장 전에 알려주는 규칙(admin-ui mcp-rules.ts)이 서버·broker 규칙과 같은지 */

const stdio = (env: Record<string, string>) => ({
  runIn: "sandbox" as const,
  transport: { type: "stdio" as const, command: "node", args: ["/opt/plugins/m/p/current/s.js"], env },
});
const http = (url: string, headers: Record<string, string> = {}) => McpServerConfig.parse({ id: "h", runIn: "broker", transport: { type: "http", url, headers } });

describe("관리 화면 MCP 규칙", () => {
  it("자격증명으로 보이는 리터럴 값 감지가 서버(findLiteralCredentials)와 같다", () => {
    const cases: [ReturnType<typeof stdio> | McpServerConfig, number][] = [
      [stdio({ GITHUB_TOKEN: "ghp_x" }), 1],
      [stdio({ GITHUB_TOKEN: "{{secret:GITHUB_TOKEN}}" }), 0],
      [stdio({ API_KEY: "a", APIKEY: "b", MY_PASSWORD: "c", AWS_ACCESS_KEY: "d", CREDENTIALS: "e" }), 5],
      [stdio({ TOKEN_URL: "https://x", LOG_LEVEL: "info", SECRET: " " }), 0],
      [http("https://x.example.com/mcp", { Authorization: "Bearer abc", "X-Api-Key": "k", Accept: "x" }), 2],
      [http("https://x.example.com/mcp", { authorization: "Bearer {{secret:T}}" }), 0],
      [http("https://u:p@x.example.com/mcp"), 1],
      [http("https://x.example.com/mcp?token=abc&page=1"), 1],
      [http("https://x.example.com/mcp?token={{secret:T}}"), 0],
    ];
    for (const [config, count] of cases) {
      const label = JSON.stringify(config.transport);
      expect(literalCredentials(config), label).toHaveLength(count);
      expect(findLiteralCredentials(config), label).toHaveLength(count);
    }
  });

  it("비밀키가 지워지는지 예측이 broker(transportTarget)와 같다", () => {
    const docs = http("https://docs.example.com/mcp?a={{secret:A}}&b={{secret:B}}", { Authorization: "Bearer {{secret:T}}" });
    const cases: [McpServerConfig, McpServerConfig, boolean][] = [
      [docs, http("https://docs.example.com/other?b={{secret:B}}&a={{secret:A}}", { authorization: "Bearer {{secret:T}}" }), false],
      [docs, http("https://docs.example.com/mcp?a={{secret:A}}", { Authorization: "Bearer {{secret:T}}" }), true],
      [docs, http("https://evil.example.com/mcp?a={{secret:A}}&b={{secret:B}}", { Authorization: "Bearer {{secret:T}}" }), true],
      [docs, http("https://docs.example.com/mcp?a={{secret:A}}&b={{secret:B}}", { Authorization: "Bearer {{secret:T}}", "X-Extra": "1" }), true],
      [docs, { ...docs, runIn: "sandbox" }, true],
    ];
    for (const [before, after, expected] of cases) {
      const label = `${JSON.stringify(before.transport)} -> ${JSON.stringify(after.transport)}`;
      expect(before.runIn !== after.runIn || transportTarget(before) !== transportTarget(after), label).toBe(expected);
      expect(clearsSecrets(before, after), label).toBe(expected);
    }
  });
});
