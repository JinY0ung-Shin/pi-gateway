import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryService } from "../../memory/src/app.js";
import { type Harness, startHarness } from "./helpers.js";

const MEMORY_KEY = "k".repeat(40);
const dataDir = mkdtempSync(join(tmpdir(), "memory-admin-"));
let memory: FastifyInstance;
let memoryUrl: string;
let h: Harness;

beforeAll(async () => {
  memory = createMemoryService({ host: "127.0.0.1", port: 0, dataDir, apiKey: MEMORY_KEY }, { log: pino({ level: "silent" }) });
  memoryUrl = await memory.listen({ host: "127.0.0.1", port: 0 });
  h = await startHarness({ env: { MEMORY_URL: memoryUrl, MEMORY_API_KEY: MEMORY_KEY } });
});
afterAll(async () => {
  await h.close();
  await memory.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const put = (owner: string, path: string, content: string) =>
  fetch(`${memoryUrl}/wiki/${owner}/note`, { method: "PUT", headers: { authorization: `Bearer ${MEMORY_KEY}` }, body: JSON.stringify({ path, content }) });

describe("admin memory", () => {
  it("lists the users that have memory and shows a user's notes", async () => {
    expect((await fetch(`${h.url}/admin/api/memory`)).status).toBe(401);
    expect((await h.admin("GET", "/memory")).json).toEqual({ wikis: [] });

    await put("alice", "projects/deploy.md", "금요일에는 배포하지 않는다");
    await put("alice", "people.md", "bob은 리뷰어다");
    await put("bob@example.com", "note.md", "x");

    const { wikis } = (await h.admin("GET", "/memory")).json;
    expect(wikis.map((w: { owner: string; notes: number; bytes: number }) => [w.owner, w.notes, w.bytes]).sort()).toEqual([
      ["alice", 2, Buffer.byteLength("금요일에는 배포하지 않는다") + Buffer.byteLength("bob은 리뷰어다")],
      ["bob@example.com", 1, 1],
    ]);

    expect((await h.admin("GET", "/memory/notes?user=alice")).json.notes.map((n: { path: string }) => n.path)).toEqual(["people.md", "projects/deploy.md"]);
    expect((await h.admin("GET", `/memory/notes?user=${encodeURIComponent("bob@example.com")}`)).json.notes).toEqual([{ path: "note.md", bytes: 1 }]);
    expect((await h.admin("GET", `/memory/note?user=alice&path=${encodeURIComponent("projects/deploy.md")}`)).json).toMatchObject({
      path: "projects/deploy.md",
      content: "금요일에는 배포하지 않는다",
    });
    expect((await h.admin("GET", `/memory/search?user=alice&q=${encodeURIComponent("배포")}`)).json.hits.map((x: { path: string }) => x.path)).toEqual(["projects/deploy.md"]);

    // memory의 거절은 같은 상태와 code로 온다
    const missing = await h.admin("GET", "/memory/note?user=alice&path=none.md");
    expect([missing.status, missing.json.error.code]).toEqual([404, "not_found"]);
    expect((await h.admin("GET", "/memory/notes?user=..%2Fx")).status).toBe(400);
    expect((await h.admin("GET", "/memory/notes")).status).toBe(400);
  });
});

describe("admin memory: the service cannot be used", () => {
  it("answers 502 for a wrong key (not 401, which would log the admin out) and 503 when unreachable", async () => {
    const wrongKey = await startHarness({ env: { MEMORY_URL: memoryUrl, MEMORY_API_KEY: "w".repeat(40) } });
    const down = await startHarness({ env: { MEMORY_URL: "http://127.0.0.1:9" } });
    try {
      const refused = await wrongKey.admin("GET", "/memory");
      expect([refused.status, refused.json.error.code]).toEqual([502, "memory_key_mismatch"]);
      const unreachable = await down.admin("GET", "/memory");
      expect([unreachable.status, unreachable.json.error.code]).toEqual([503, "memory_unavailable"]);
    } finally {
      await wrongKey.close();
      await down.close();
    }
  });
});
