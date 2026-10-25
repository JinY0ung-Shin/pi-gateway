import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 테스트용 최소 MCP Streamable HTTP 서버. 받은 요청을 기록하고, 받은 헤더를 도구 결과로 돌려준다. */
export interface HttpFixture {
  url: string;
  requests: { method: string; headers: IncomingHttpHeaders; body: unknown }[];
  close(): Promise<void>;
}

const tool = (name: string, description: string, properties: Record<string, unknown> = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties },
});

const TOOLS = [
  tool("headers", "echo selected request headers"),
  tool("echo_auth", "returns the Authorization header"),
  tool("whoami", "returns the X-User and X-Thread headers"),
  tool("leak", "returns the X-Leak header in many encodings"),
  tool("tool_error", "isError result containing X-Leak"),
  tool("fail", "JSON-RPC error containing X-Leak"),
  tool("bad_args", "invalid params error"),
  tool("slow", "sleeps, emitting progress (SSE)", { ms: { type: "number" }, steps: { type: "number" } }),
  tool("progress_burst", "progress and result in the same write (SSE)"),
  tool("hidden", "should be filtered by toolDeny"),
];

type Message = { id?: number | string; method: string; params?: { name?: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: unknown } } };
type Reply = { result: unknown } | { error: { code: number; message: string } };

const text = (t: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: t }], ...extra });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const event = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

function callTool(name: string | undefined, headers: IncomingHttpHeaders): Reply {
  const secret = String(headers["x-leak"] ?? "");
  switch (name) {
    case "headers":
      return {
        result: text(
          JSON.stringify({
            authorization: headers.authorization ?? null,
            xUser: headers["x-user"] ?? null,
            xToken: headers["x-forwarded-token"] ?? null,
          }),
        ),
      };
    case "echo_auth":
      return { result: text(`auth=${headers.authorization ?? ""}`) };
    case "whoami":
      return { result: text(JSON.stringify({ user: headers["x-user"] ?? null, thread: headers["x-thread"] ?? null })) };
    case "leak": {
      const b = Buffer.from(secret, "utf8");
      const basic = Buffer.from(`someuser:${secret}`, "utf8").toString("base64");
      return {
        result: {
          content: [
            { type: "text", text: `raw=${secret}` },
            { type: "text", text: `b64=${b.toString("base64")} b64url=${b.toString("base64url")}` },
            { type: "text", text: `hex=${b.toString("hex")} url=${encodeURIComponent(secret)} basic=Basic ${basic}` },
          ],
          structuredContent: { nested: { secret }, [secret]: "key-leak" },
        },
      };
    }
    case "tool_error":
      return { result: text(`upstream failed with token ${secret}`, { isError: true }) };
    case "fail":
      return { error: { code: -32603, message: `boom: credential ${secret} rejected` } };
    case "bad_args":
      return { error: { code: -32602, message: `missing required argument 'repo' (token ${secret})` } };
    case "hidden":
      return { result: text("you should not see this") };
    default:
      return { error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

/** 진행 알림을 보내는 도구는 SSE로 답한다. */
async function streamTool(res: ServerResponse, msg: Message, secret: string): Promise<void> {
  const progressToken = msg.params?._meta?.progressToken;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (msg.params?.name === "progress_burst") {
    const notices = progressToken === undefined ? [] : [1, 2, 3].map((i) => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: i, total: 3 } }));
    res.end([...notices, { jsonrpc: "2.0", id: msg.id, result: text("burst done") }].map(event).join(""));
    return;
  }
  const ms = Number(msg.params?.arguments?.ms ?? 100);
  const steps = Number(msg.params?.arguments?.steps ?? 1);
  for (let i = 1; i <= steps; i++) {
    await sleep(ms / steps);
    if (res.destroyed) return;
    if (progressToken !== undefined) {
      res.write(event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: i, total: steps, message: `step ${i} ${secret}` } }));
    }
  }
  // 결과와 같은 묶음으로 온 마지막 진행 알림은 버려질 수 있어서 조금 띄운다.
  await sleep(30);
  if (!res.destroyed) res.end(event({ jsonrpc: "2.0", id: msg.id, result: text("done") }));
}

export async function startHttpFixture(): Promise<HttpFixture> {
  const requests: HttpFixture["requests"] = [];
  const server: Server = createServer((req, res) => {
    res.on("error", () => {});
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? "", headers: req.headers, body });
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const msg = body as Message;
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let reply: Reply;
      switch (msg.method) {
        case "initialize":
          reply = {
            result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture-http", version: "1.0.0" } },
          };
          break;
        case "tools/list":
          reply = { result: { tools: TOOLS } };
          break;
        case "tools/call":
          if (msg.params?.name === "slow" || msg.params?.name === "progress_burst") {
            void streamTool(res, msg, String(req.headers["x-leak"] ?? ""));
            return;
          }
          reply = callTool(msg.params?.name, req.headers);
          break;
        default:
          reply = { error: { code: -32601, message: "not found" } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
