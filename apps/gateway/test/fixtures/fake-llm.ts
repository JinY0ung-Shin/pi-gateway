import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 테스트용 OpenAI 호환 LLM 서버 (`POST /v1/chat/completions`, stream=true, `GET /v1/models`).
 * 요청마다 큐에서 시나리오 하나를 꺼내 SSE chunk로 응답한다.
 */

export interface FakeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeTurn {
  reasoning?: string;
  text?: string;
  /** text를 여러 chunk로 나눠 보낸다 */
  textChunks?: string[];
  toolCalls?: FakeToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  /** 첫 chunk 전 지연 */
  delayMs?: number;
  /** chunk 사이 지연 */
  chunkDelayMs?: number;
  /** HTTP 오류로 응답 */
  error?: { status: number; body: unknown };
  /** 텍스트를 보낸 뒤 연결을 끊는다 (스트림 도중 끊김 → pi auto retry) */
  dropConnection?: boolean;
}

export type FakeScript = FakeTurn | ((request: ChatRequest, index: number) => FakeTurn);

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface FakeLlm {
  url: string;
  requests: ChatRequest[];
  headers: IncomingMessage["headers"][];
  /** `GET /v1/models`가 돌려줄 목록 (vLLM 모양) */
  models: Array<{ id: string; max_model_len?: number }>;
  /** `GET /v1/models` 요청의 헤더 */
  modelRequests: IncomingMessage["headers"][];
  /** 다음 요청들에 쓸 시나리오를 추가한다 */
  enqueue(...turns: FakeScript[]): void;
  /** 큐가 비었을 때 쓰는 기본 응답 */
  setDefault(turn: FakeScript): void;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLlm(): Promise<FakeLlm> {
  const queue: FakeScript[] = [];
  let fallback: FakeScript = { text: "ok" };
  const requests: ChatRequest[] = [];
  const headers: IncomingMessage["headers"][] = [];
  const models: FakeLlm["models"] = [];
  const modelRequests: IncomingMessage["headers"][] = [];
  let callIndex = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && (req.url === "/v1/models" || req.url?.startsWith("/v1/models?"))) {
      modelRequests.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((m) => ({ object: "model", owned_by: "vllm", ...m })) }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
    requests.push(body);
    headers.push(req.headers);
    const index = callIndex++;
    const script = queue.shift() ?? fallback;
    const turn = typeof script === "function" ? script(body, index) : script;

    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.error) {
      res.writeHead(turn.error.status, { "content-type": "application/json" });
      res.end(JSON.stringify(turn.error.body));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const id = `chatcmpl-${index}`;
    const created = Math.floor(Date.now() / 1000);
    const send = async (delta: Record<string, unknown>, finish: string | null = null) => {
      if (closed) return;
      const payload = { id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
    };

    await send({ role: "assistant" });
    if (turn.reasoning) await send({ reasoning_content: turn.reasoning });
    const textChunks = turn.textChunks ?? (turn.text !== undefined ? [turn.text] : []);
    for (const t of textChunks) await send({ content: t });
    if (turn.dropConnection) {
      await sleep(20);
      res.socket?.destroy();
      return;
    }
    const toolCalls = turn.toolCalls ?? [];
    for (const [i, call] of toolCalls.entries()) {
      const callId = call.id ?? `call_${index}_${i}`;
      const args = JSON.stringify(call.arguments);
      const half = Math.floor(args.length / 2);
      await send({ tool_calls: [{ index: i, id: callId, type: "function", function: { name: call.name, arguments: args.slice(0, half) } }] });
      await send({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] });
    }
    await send({}, toolCalls.length > 0 ? "tool_calls" : "stop");
    if (!closed) {
      const usage = turn.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
      const usagePayload = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [],
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.prompt_tokens + usage.completion_tokens,
          ...(usage.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
        },
      };
      res.write(`data: ${JSON.stringify(usagePayload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    headers,
    models,
    modelRequests,
    enqueue: (...turns) => {
      queue.push(...turns);
    },
    setDefault: (turn) => {
      fallback = turn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
