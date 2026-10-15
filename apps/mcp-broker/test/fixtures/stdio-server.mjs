#!/usr/bin/env node
// 테스트용 최소 MCP stdio 서버 (의존성 없음). 줄 단위 JSON-RPC.
import { spawn } from "node:child_process";

const TOOLS = [
  { name: "whoami", description: "pid/uid/cwd/argv/USER_ID", inputSchema: { type: "object", properties: {} } },
  { name: "echo_env", description: "returns the whole environment", inputSchema: { type: "object", properties: {} } },
  { name: "leak", description: "returns LEAK_VALUE in many encodings", inputSchema: { type: "object", properties: {} } },
  { name: "tool_error", description: "isError result containing LEAK_VALUE", inputSchema: { type: "object", properties: {} } },
  { name: "fail", description: "JSON-RPC error containing LEAK_VALUE", inputSchema: { type: "object", properties: {} } },
  { name: "bad_args", description: "invalid params error", inputSchema: { type: "object", properties: {} } },
  {
    name: "slow",
    description: "sleeps, emitting progress",
    inputSchema: { type: "object", properties: { ms: { type: "number" }, steps: { type: "number" } } },
  },
  { name: "spawn_grandchild", description: "spawns sleep 1000 and returns its pid", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "returns n bytes", inputSchema: { type: "object", properties: { n: { type: "number" } } } },
  { name: "progress_burst", description: "progress and result in the same write", inputSchema: { type: "object", properties: {} } },
  { name: "escape_group", description: "starts a setsid'd descendant outside our process group", inputSchema: { type: "object", properties: {} } },
  { name: "hidden", description: "should be filtered by toolDeny", inputSchema: { type: "object", properties: {} } },
];

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

async function callTool(name, args, progressToken) {
  const secret = process.env.LEAK_VALUE ?? "";
  switch (name) {
    case "whoami":
      return text(
        JSON.stringify({
          pid: process.pid,
          uid: process.getuid?.(),
          cwd: process.cwd(),
          argv: process.argv.slice(2),
          userId: process.env.USER_ID ?? null,
          threadId: process.env.THREAD_ID ?? null,
        }),
      );
    case "echo_env":
      return text(JSON.stringify(process.env));
    case "leak": {
      const b = Buffer.from(secret, "utf8");
      const basic = Buffer.from(`someuser:${secret}`, "utf8").toString("base64");
      return {
        content: [
          { type: "text", text: `raw=${secret}` },
          { type: "text", text: `b64=${b.toString("base64")} b64url=${b.toString("base64url")}` },
          { type: "text", text: `hex=${b.toString("hex")} url=${encodeURIComponent(secret)} basic=Basic ${basic}` },
        ],
        structuredContent: { nested: { secret }, [secret]: "key-leak" },
      };
    }
    case "tool_error":
      return text(`upstream failed with token ${secret}`, { isError: true });
    case "fail": {
      const err = new Error(`boom: credential ${secret} rejected`);
      err.code = -32603;
      throw err;
    }
    case "bad_args": {
      const err = new Error(`missing required argument 'repo' (token ${secret})`);
      err.code = -32602;
      throw err;
    }
    case "slow": {
      const ms = Number(args?.ms ?? 100);
      const steps = Number(args?.steps ?? 1);
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, ms / steps));
        if (progressToken !== undefined) {
          write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: i, total: steps, message: `step ${i} ${secret}` } });
        }
      }
      // SDK 클라이언트는 결과와 같은 묶음으로 온 마지막 진행 알림을 버릴 수 있어서 조금 띄운다.
      await new Promise((r) => setTimeout(r, 30));
      return text("done");
    }
    case "spawn_grandchild": {
      const child = spawn("sleep", ["1000"], { stdio: "ignore" });
      return text(JSON.stringify({ pid: child.pid }));
    }
    case "progress_burst": {
      if (progressToken !== undefined) {
        for (let i = 1; i <= 3; i++) {
          write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: i, total: 3 } });
        }
      }
      return text("burst done");
    }
    case "escape_group": {
      // detached → 자식이 setsid()를 불러 새 세션·process group을 만든다 (process group kill로는 안 죽는다).
      const child = spawn("sleep", ["1000"], { stdio: "ignore", detached: true });
      child.unref();
      return text(JSON.stringify({ pid: child.pid }));
    }
    case "big":
      return text("x".repeat(Number(args?.n ?? 10)));
    case "hidden":
      return text("you should not see this");
    default: {
      const err = new Error(`unknown tool ${name}`);
      err.code = -32602;
      throw err;
    }
  }
}

async function handle(msg) {
  if (msg.id === undefined) return; // notification
  try {
    let result;
    switch (msg.method) {
      case "initialize":
        result = {
          protocolVersion: msg.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture-stdio", version: "1.0.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        result = await callTool(msg.params?.name, msg.params?.arguments, msg.params?._meta?.progressToken);
        break;
      default: {
        const err = new Error(`method not found: ${msg.method}`);
        err.code = -32601;
        throw err;
      }
    }
    write({ jsonrpc: "2.0", id: msg.id, result });
  } catch (error) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: error.code ?? -32603, message: error.message } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
process.stderr.write(`fixture started with secret ${process.env.LEAK_VALUE ?? ""}\n`);
