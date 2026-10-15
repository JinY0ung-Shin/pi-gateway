import type { ServerResponse } from "node:http";

/**
 * SSE 프레임 쓰기: `event: <type>\ndata: <json>\n\n`.
 * sequence_number는 응답 하나 안에서 0부터 1씩 증가한다 (oh-my-gateway와 같다).
 */
export class SseWriter {
  private seq = 0;
  private keepalive: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly res: ServerResponse) {}

  start(headers: Record<string, string> = {}): void {
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...headers,
    });
    this.res.flushHeaders?.();
    this.res.on("close", () => {
      this.closed = true;
      this.stopKeepalive();
    });
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded || this.res.destroyed;
  }

  send(type: string, payload: Record<string, unknown>): void {
    if (this.isClosed) return;
    const data = { type, ...payload, sequence_number: this.seq++ };
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.isClosed) return;
    this.res.write(`: ${text}\n\n`);
  }

  startKeepalive(intervalMs: number, onTick?: () => void): void {
    if (intervalMs <= 0) return;
    this.keepalive = setInterval(() => {
      this.comment("keepalive");
      onTick?.();
    }, intervalMs);
    this.keepalive.unref?.();
  }

  stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  end(): void {
    this.stopKeepalive();
    if (!this.res.writableEnded) this.res.end();
  }
}
