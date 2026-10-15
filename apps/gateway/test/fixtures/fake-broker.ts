import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AUD_BROKER, bearerToken, type VerifiedInternalClaims, verifyInternalToken } from "@pi-gateway/shared";

/**
 * 테스트용 가짜 mcp-broker 데이터 평면.
 * - GET /mcp/servers
 * - POST /mcp/:id — stateless JSON-RPC (initialize, notifications/initialized, tools/list, tools/call)
 * 받은 요청마다 검증한 JWT claims를 기록한다.
 */

export interface FakeBrokerTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** content를 주면 text 대신 그대로 돌려준다 (이미지 블록 등) */
  handler: (
    args: Record<string, unknown>,
    claims: VerifiedInternalClaims,
  ) => { text?: string; isError?: boolean; content?: unknown[]; rpcError?: { code: number; message: string } };
  /** 첫 tools/call에 HTTP 404(세션 만료)로 답한다. 서버가 처리하지 않은 요청이므로 gateway가 다시 보내도 된다. */
  notFoundOnce?: boolean;
}

export interface FakeBrokerRecord {
  serverId: string;
  method: string;
  claims: VerifiedInternalClaims;
}

export interface FakeBroker {
  url: string;
  records: FakeBrokerRecord[];
  /** 도구별로 handler가 실제로 실행된 횟수 */
  executions: Record<string, number>;
  authFailures: string[];
  close(): Promise<void>;
}

export async function startFakeBroker(secret: Uint8Array, servers: Record<string, FakeBrokerTool[]>): Promise<FakeBroker> {
  const records: FakeBrokerRecord[] = [];
  const authFailures: string[] = [];
  const executions: Record<string, number> = {};
  const notFoundServed = new Set<string>();

  const auth = async (req: IncomingMessage): Promise<VerifiedInternalClaims | null> => {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      authFailures.push("missing token");
      return null;
    }
    try {
      return await verifyInternalToken(secret, AUD_BROKER, token);
    } catch (err) {
      authFailures.push(String(err));
      return null;
    }
  };

  const server: Server = createServer(async (req, res) => {
    const claims = await auth(req);
    if (!claims) {
      res.writeHead(401).end();
      return;
    }
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "GET" && path === "/mcp/servers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ servers: Object.keys(servers).map((id) => ({ id, displayName: id, timeoutSec: 30 })) }));
      return;
    }
    const m = /^\/mcp\/([^/]+)$/.exec(path);
    if (!m || req.method !== "POST" || !servers[m[1]!]) {
      res.writeHead(405).end();
      return;
    }
    const serverId = decodeURIComponent(m[1]!);
    const tools = servers[serverId]!;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number | string; method: string; params?: Record<string, unknown> };
    records.push({ serverId, method: msg.method, claims });
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    switch (msg.method) {
      case "initialize":
        result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: `fake-${serverId}`, version: "1" } };
        break;
      case "tools/list":
        result = {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } })),
        };
        break;
      case "tools/call": {
        const tool = tools.find((t) => t.name === msg.params?.name);
        const toolKey = `${serverId}/${String(msg.params?.name)}`;
        if (tool?.notFoundOnce && !notFoundServed.has(toolKey)) {
          notFoundServed.add(toolKey);
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "not_found", message: "session expired" } }));
          return;
        }
        executions[toolKey] = (executions[toolKey] ?? 0) + 1;
        const out = tool ? tool.handler((msg.params?.arguments ?? {}) as Record<string, unknown>, claims) : { text: "unknown tool", isError: true };
        if (out.rpcError) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: out.rpcError }));
          return;
        }
        result = { content: out.content ?? [{ type: "text", text: out.text ?? "" }], ...(out.isError ? { isError: true } : {}) };
        break;
      }
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    records,
    executions,
    authFailures,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
