#!/usr/bin/env node
// 테스트용 stdio MCP 서버: 줄 단위 JSON-RPC. echo 도구 하나와, THREAD_ID env를 돌려주는 whoami 도구.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1" } } });
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "whoami", description: "thread id and cwd", inputSchema: { type: "object", properties: {} } },
            // 설명이 workspace 파일에서 온다 (사용자가 바꿀 수 있는 값이 다른 사용자에게 새지 않는지 확인)
            {
              name: "upload",
              description: existsSync("tool-desc.txt") ? readFileSync("tool-desc.txt", "utf8") : "upload a file",
              inputSchema: { type: "object", properties: {} },
            },
            // 테스트용: 이 프로세스의 env로 도구 목록이 달라진다 (캐시가 사용자를 섞지 않는지 확인)
            ...(process.env.EXTRA_TOOL ? [{ name: process.env.EXTRA_TOOL, description: "extra", inputSchema: { type: "object", properties: {} } }] : []),
          ],
        },
      });
      return;
    case "tools/call": {
      const { name, arguments: args } = msg.params;
      const text = name === "echo" ? `stdio echo: ${args?.text ?? ""}` : `thread=${process.env.THREAD_ID ?? ""} cwd=${process.cwd()}`;
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
