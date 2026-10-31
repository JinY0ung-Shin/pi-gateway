import type { Client } from "@modelcontextprotocol/client";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { type Lease, PoolCapacityError, UpstreamPool } from "../src/pool.js";
import type { RenderedTransport } from "../src/render.js";

// connect를 가짜로 바꾸므로 transport는 쓰이지 않는다.
const rendered = {} as RenderedTransport;
const key = (token: string) => ({ serverId: "noah", scopeKey: "shared", renderedHash: token });

function pool(maxConnections: number) {
  const clients: Client[] = [];
  const closed: Client[] = [];
  const p = new UpstreamPool({
    limits: { maxConnections, idleTtlSeconds: 300 },
    connect: async () => {
      // 풀은 client를 꺼내 주기만 한다.
      const client = {} as Client;
      clients.push(client);
      return { client, close: async () => void closed.push(client) };
    },
    log: pino({ level: "silent" }),
  });
  return { p, clients, closed };
}

describe("UpstreamPool capacity", () => {
  it("모든 연결이 쓰이는 중이면 기다렸다가, 하나가 쉬면 그 연결을 닫고 새로 연결한다", async () => {
    const { p, clients, closed } = pool(1);
    const first = await p.acquire(key("a"), rendered);
    let second: Lease | undefined;
    const waiting = p.acquire(key("b"), rendered).then((lease) => (second = lease));
    await new Promise((r) => setImmediate(r));
    expect(second).toBeUndefined();

    first.release();
    await waiting;
    expect(closed).toEqual([clients[0]]);
    expect(second!.client).toBe(clients[1]);
    await p.closeAll();
  });

  it("signal이 끝날 때까지 자리가 나지 않으면 PoolCapacityError로 실패하고, 기다리던 자리를 남기지 않는다", async () => {
    const { p } = pool(1);
    const first = await p.acquire(key("a"), rendered);
    const abort = new AbortController();
    const waiting = p.acquire(key("b"), rendered, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(PoolCapacityError);

    // 같은 키로 다시 기다릴 수 있고(backoff 없음), 자리가 나면 연결된다.
    const retry = p.acquire(key("b"), rendered);
    first.release();
    await expect(retry).resolves.toBeDefined();
    await p.closeAll();
  });

  it("종료하면 기다리던 acquire가 실패한다", async () => {
    const { p } = pool(1);
    await p.acquire(key("a"), rendered);
    const waiting = p.acquire(key("b"), rendered);
    await new Promise((r) => setImmediate(r));
    await p.closeAll();
    await expect(waiting).rejects.toBeInstanceOf(PoolCapacityError);
  });
});
