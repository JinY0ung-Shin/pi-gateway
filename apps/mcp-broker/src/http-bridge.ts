import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { FastifyReply, FastifyRequest } from "fastify";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

/** Fastify 요청을 web 표준 Request로 바꾼다. 본문은 문자열로 받아 둔 것을 쓴다. */
export function toWebRequest(req: FastifyRequest, signal: AbortSignal, dropHeaders: readonly string[] = []): Request {
  const url = new URL(req.url, "http://mcp-broker.internal");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || dropHeaders.includes(name)) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const init: RequestInit = { method: req.method, headers, signal };
  if (req.method !== "GET" && req.method !== "HEAD" && typeof req.body === "string") init.body = req.body;
  return new Request(url, init);
}

/** web 표준 Response를 Fastify로 보낸다. SSE 같은 스트림 본문도 그대로 흘려보낸다. */
export async function sendWebResponse(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  reply.code(res.status);
  res.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) reply.header(name, value);
  });
  if (!res.body) return reply.send();
  return reply.send(Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>));
}
