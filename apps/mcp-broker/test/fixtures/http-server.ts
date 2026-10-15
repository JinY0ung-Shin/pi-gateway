import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 테스트용 최소 MCP Streamable HTTP 서버. 받은 헤더를 기록하고 도구로 돌려준다. */
export interface HttpFixture {
  url: string;
  requests: { method: string; headers: IncomingHttpHeaders; body: unknown }[];
  close(): Promise<void>;
}

const TOOLS = [
  { name: "headers", description: "echo selected request headers", inputSchema: { type: "object", properties: {} } },
  { name: "echo_auth", description: "returns the Authorization header", inputSchema: { type: "object", properties: {} } },
];

export async function startHttpFixture(): Promise<HttpFixture> {
  const requests: HttpFixture["requests"] = [];
  const server: Server = createServer((req, res) => {
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
      const msg = body as { id?: number | string; method: string; params?: { name?: string } };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      switch (msg.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture-http", version: "1.0.0" },
          };
          break;
        case "tools/list":
          result = { tools: TOOLS };
          break;
        case "tools/call":
          if (msg.params?.name === "echo_auth") {
            result = { content: [{ type: "text", text: `auth=${req.headers.authorization ?? ""}` }] };
          } else {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    authorization: req.headers.authorization ?? null,
                    xUser: req.headers["x-user"] ?? null,
                    xToken: req.headers["x-forwarded-token"] ?? null,
                  }),
                },
              ],
            };
          }
          break;
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }));
          return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
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
