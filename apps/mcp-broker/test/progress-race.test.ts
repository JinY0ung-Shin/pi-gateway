import { describe, expect, it } from "vitest";
import { startHttpFixture } from "./fixtures/http-server.js";
import { piClient, startTestBroker, textOf } from "./helpers.js";

describe("progress relay race", () => {
  it("결과와 같은 묶음으로 온 진행 알림이 응답을 붙잡지 않는다", async () => {
    const tb = await startTestBroker();
    const http = await startHttpFixture();
    try {
      await tb.addHttpServer("burst", http.url);
      const client = await piClient(tb, "burst", { sub: "alice", sid: "s1" });
      for (let i = 0; i < 10; i++) {
        const progress: unknown[] = [];
        const result = await client.callTool("progress_burst", {}, { onProgress: (p) => progress.push(p) });
        expect(textOf(result)).toBe("burst done");
        expect(progress.length).toBeLessThanOrEqual(3);
      }
      await client.close();
      const started = Date.now();
      await tb.broker.dataPlane.close();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await tb.close();
      await http.close();
    }
  });
});
