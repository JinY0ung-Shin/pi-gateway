import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

/**
 * Fastify 요청·응답을 web 표준 Request·Response로 잇는다 (MCP 서버 SDK의 handler가 web 표준을 받는다).
 * Fastify에 의존하지 않도록 필요한 모양만 적었다.
 */

/** 내부 서비스의 오류 응답 본문 */
export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

interface BridgeRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body?: unknown;
}

interface BridgeReply<T> {
  code(status: number): unknown;
  header(name: string, value: string): unknown;
  send(payload?: unknown): T;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

/**
 * Fastify 요청을 web 표준 Request로 바꾼다. 본문은 문자열로 받아 둔 것을 쓴다.
 * Authorization(이 서비스를 부르는 데 쓴 자격증명)은 넘기지 않는다. `base`는 요청 URL의 origin 자리를 채운다.
 */
export function toWebRequest(req: BridgeRequest, signal: AbortSignal, base: string): Request {
  const url = new URL(req.url, base);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name === "authorization") continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const init: RequestInit = { method: req.method, headers, signal };
  if (req.method !== "GET" && req.method !== "HEAD" && typeof req.body === "string") init.body = req.body;
  return new Request(url, init);
}

/** web 표준 Response를 Fastify로 보낸다. SSE 같은 스트림 본문도 그대로 흘려보낸다. */
export async function sendWebResponse<T>(reply: BridgeReply<T>, res: Response): Promise<T> {
  reply.code(res.status);
  res.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) reply.header(name, value);
  });
  if (!res.body) return reply.send();
  return reply.send(Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>));
}
