import type { LookupAddress } from "node:dns";
import { createCachedLookup } from "@pi-gateway/shared";
import { describe, expect, it } from "vitest";

const A: LookupAddress[] = [{ address: "10.0.0.1", family: 4 }];
const B: LookupAddress[] = [{ address: "10.0.0.2", family: 4 }];

function harness(results: (LookupAddress[] | Error)[]) {
  let clock = 0;
  const calls: string[] = [];
  const pending: (() => void)[] = [];
  const lookup = createCachedLookup(
    (hostname) => {
      calls.push(hostname);
      const next = results.shift()!;
      return new Promise<LookupAddress[]>((resolve, reject) => pending.push(() => (next instanceof Error ? reject(next) : resolve(next))));
    },
    () => clock,
  );
  const ask = (hostname: string) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) =>
      lookup(hostname, {}, (err, address) => resolve({ err, address })),
    );
  return {
    calls,
    ask,
    settle: async () => {
      while (pending.length) pending.shift()!();
      await new Promise((r) => setImmediate(r));
    },
    advance: (ms: number) => (clock += ms),
  };
}

describe("createCachedLookup", () => {
  it("같은 이름의 동시 조회는 한 번만 찾는다", async () => {
    const h = harness([A]);
    const answers = Promise.all([h.ask("mcp-broker"), h.ask("mcp-broker"), h.ask("mcp-broker")]);
    await h.settle();
    expect((await answers).map((a) => a.address)).toEqual(["10.0.0.1", "10.0.0.1", "10.0.0.1"]);
    expect(h.calls).toEqual(["mcp-broker"]);
  });

  it("오래된 값은 바로 쓰고 뒤에서 새로 찾으며, 새로 찾다 실패하면 이전 값을 계속 쓴다", async () => {
    const h = harness([A, new Error("dns down"), B]);
    const first = h.ask("sandboxd");
    await h.settle();
    expect((await first).address).toBe("10.0.0.1");

    h.advance(31_000);
    // 조회가 끝나지 않았어도 이전 값으로 바로 답한다.
    expect((await h.ask("sandboxd")).address).toBe("10.0.0.1");
    await h.settle();
    expect((await h.ask("sandboxd")).address).toBe("10.0.0.1");

    await h.settle();
    expect((await h.ask("sandboxd")).address).toBe("10.0.0.2");
    expect(h.calls).toEqual(["sandboxd", "sandboxd", "sandboxd"]);
  });

  it("기억한 값이 없으면 조회 오류를 그대로 돌려주고, 다음 요청은 다시 찾는다", async () => {
    const h = harness([new Error("ENOTFOUND"), A]);
    const failed = h.ask("upstream");
    await h.settle();
    expect((await failed).err?.message).toBe("ENOTFOUND");
    const retried = h.ask("upstream");
    await h.settle();
    expect((await retried).address).toBe("10.0.0.1");
  });
});
