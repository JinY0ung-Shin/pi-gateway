import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userKey } from "@pi-gateway/shared";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryService } from "../src/app.js";
import { READ_PAGE_BYTES } from "../src/wiki.js";

const API_KEY = randomBytes(32).toString("hex");
let dataDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "memory-rest-test-"));
  app = createMemoryService({ host: "127.0.0.1", port: 0, dataDir, apiKey: API_KEY }, { log: pino({ level: "silent" }) });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${API_KEY}` };
const call = async (method: "GET" | "PUT" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = auth) => {
  const res = await app.inject({ method, url, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
};
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

describe("프로그램용 API (/wiki/<owner>)", () => {
  it("노트를 쓰고, 전문을 읽고, hash로 바꾸고, 지운다", async () => {
    const created = await call("PUT", "/wiki/alice/note", { path: "wiki/개념/배포.md", content: "금요일에는 하지 않는다" });
    expect(created).toEqual({ status: 200, json: { path: "wiki/개념/배포.md", hash: expect.stringMatching(/^[0-9a-f]{64}$/), created: true } });
    const read = await call("GET", `/wiki/alice/note?${q({ path: "wiki/개념/배포.md" })}`);
    expect(read.json).toEqual({ path: "wiki/개념/배포.md", content: "금요일에는 하지 않는다", hash: created.json.hash });

    expect((await call("PUT", "/wiki/alice/note", { path: "wiki/개념/배포.md", content: "x" })).json.error.code).toBe("exists");
    const replaced = await call("PUT", "/wiki/alice/note", { path: "wiki/개념/배포.md", content: "목요일까지만 한다", hash: created.json.hash });
    expect(replaced.json.created).toBe(false);
    // 옛 hash로는 바꾸거나 지울 수 없다.
    expect((await call("PUT", "/wiki/alice/note", { path: "wiki/개념/배포.md", content: "y", hash: created.json.hash })).status).toBe(409);
    expect((await call("DELETE", `/wiki/alice/note?${q({ path: "wiki/개념/배포.md", hash: created.json.hash })}`)).json.error.code).toBe("stale");
    expect(await call("DELETE", `/wiki/alice/note?${q({ path: "wiki/개념/배포.md", hash: replaced.json.hash })}`)).toEqual({ status: 200, json: { path: "wiki/개념/배포.md" } });
    expect((await call("GET", `/wiki/alice/note?${q({ path: "wiki/개념/배포.md" })}`)).status).toBe(404);
    // 이미 지운 노트를 다시 지우면 충돌이 아니라 없음이다. hash를 내고 바꾸려는 것은 충돌이다.
    const again = await call("DELETE", `/wiki/alice/note?${q({ path: "wiki/개념/배포.md", hash: replaced.json.hash })}`);
    expect([again.status, again.json.error.code]).toEqual([404, "not_found"]);
    expect((await call("PUT", "/wiki/alice/note", { path: "wiki/개념/배포.md", content: "z", hash: replaced.json.hash })).json.error.code).toBe("stale");
    // 주인처럼 보이는 값을 본문이나 query에 넣어도 URL의 주인만 본다.
    await call("PUT", "/wiki/alice/note?owner=bob", { path: "mine.md", content: "alice", owner: "bob", user: "bob" });
    expect((await call("GET", "/wiki/alice/notes?owner=bob")).json.notes).toEqual([{ path: "mine.md", bytes: 5 }]);
    expect((await call("GET", "/wiki/bob/note?path=mine.md")).status).toBe(404);
  });

  it("모델용 도구와 달리 긴 노트의 전문을 주고 통째로 바꿀 수 있다", async () => {
    const long = `${"가나다라 ".repeat(READ_PAGE_BYTES / 4)}끝`;
    const created = await call("PUT", "/wiki/bob/note", { path: "long.md", content: long });
    const read = await call("GET", "/wiki/bob/note?path=long.md");
    expect(Buffer.byteLength(read.json.content)).toBeGreaterThan(READ_PAGE_BYTES * 2);
    expect(read.json.content).toBe(long);
    const replaced = await call("PUT", "/wiki/bob/note", { path: "long.md", content: `${long}!`, hash: created.json.hash });
    expect(replaced.status).toBe(200);
  });

  it("목록은 자르지 않고 전부 주고, 폴더로 좁히고, 검색한다", async () => {
    const folder = "folder-with-a-long-name/".repeat(10);
    for (let i = 0; i < 300; i++) await call("PUT", "/wiki/carol/note", { path: `${folder}note-${String(i).padStart(3, "0")}.md`, content: i === 7 ? "needle" : "hay" });
    await call("PUT", "/wiki/carol/note", { path: "other/a.md", content: "---\ntitle: Needle case\n---\nbody" });
    const all = await call("GET", "/wiki/carol/notes");
    expect(all.json.notes).toHaveLength(301);
    expect(all.json.notes[0]).toEqual({ path: `${folder}note-000.md`, bytes: 3 });
    expect((await call("GET", "/wiki/carol/notes?prefix=other")).json.notes).toEqual([{ path: "other/a.md", bytes: expect.any(Number) }]);
    const found = await call("GET", `/wiki/carol/search?${q({ q: "needle" })}`);
    expect(found.json.unscanned).toBe(0);
    expect(found.json.hits.map((h: { path: string }) => h.path)).toEqual(["other/a.md", `${folder}note-007.md`]);
    expect((await call("GET", `/wiki/carol/search?${q({ q: "needle", limit: "1" })}`)).json.hits).toHaveLength(1);
  });

  it("주인의 wiki를 통째로 지우고, 다른 주인의 것은 남는다", async () => {
    await call("PUT", "/wiki/dave/note", { path: "a.md", content: "dave" });
    await call("PUT", "/wiki/erin/note", { path: "a.md", content: "erin" });
    expect(await call("DELETE", "/wiki/dave")).toEqual({ status: 200, json: { deleted: true } });
    expect((await call("GET", "/wiki/dave/notes")).json.notes).toEqual([]);
    expect((await call("GET", "/wiki/erin/note?path=a.md")).json.content).toBe("erin");
    // 없는 wiki를 지워도 되고, 지운 뒤 다시 쓸 수 있다 (세어 둔 값이 남아 있지 않다).
    expect((await call("DELETE", "/wiki/dave")).status).toBe(200);
    expect((await call("PUT", "/wiki/dave/note", { path: "a.md", content: "again" })).json.created).toBe(true);
  });

  it("거절은 code와 상태로, 저장소 실패는 500으로 답한다 (빈 결과로 바꾸지 않는다)", async () => {
    expect((await call("PUT", "/wiki/frank/note", { path: "../x.md", content: "x" })).json.error.code).toBe("invalid_path");
    expect((await call("GET", "/wiki/frank/note?path=none.md")).status).toBe(404);
    expect((await call("GET", "/wiki/frank/note")).json.error.code).toBe("invalid_request");
    expect((await call("PUT", "/wiki/frank/note", { path: "a.md" })).status).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/wiki/frank/note", headers: auth, payload: "{not json" })).statusCode).toBe(400);
    expect((await call("GET", `/wiki/frank/search?${q({ q: "  " })}`)).json.error.code).toBe("invalid_query");
    // 모양이 틀린 hash, 되풀이된 query key, 범위 밖 limit은 잘못된 요청이다.
    expect((await call("PUT", "/wiki/frank/note", { path: "a.md", content: "x", hash: "" })).json.error.code).toBe("invalid_request");
    expect((await call("DELETE", "/wiki/frank/note?path=a.md&hash=xyz")).json.error.code).toBe("invalid_request");
    expect((await call("GET", "/wiki/frank/note?path=a.md&path=b.md")).json.error.code).toBe("invalid_request");
    for (const limit of ["0", "21", "1.5", "abc"]) expect((await call("GET", `/wiki/frank/search?${q({ q: "x", limit })}`)).status, limit).toBe(400);
    expect((await call("PUT", "/wiki/frank/note", { path: "big.md", content: "a".repeat(512 * 1024 + 1) })).status).toBe(413);
    expect((await call("GET", "/wiki/-bad/notes")).json.error.code).toBe("invalid_owner");
    mkdirSync(join(dataDir, "wikis"), { recursive: true });
    writeFileSync(join(dataDir, "wikis", userKey("grace")), "not a folder");
    expect(await call("GET", "/wiki/grace/notes")).toEqual({ status: 500, json: { error: { code: "internal", message: "the memory store failed" } } });
  });

  it("Fastify가 직접 내는 오류도 같은 모양이고, 없는 라우트는 없는 노트와 code가 다르다", async () => {
    expect(await call("GET", "/wiki/alice/notes/")).toEqual({ status: 404, json: { error: { code: "no_route", message: expect.any(String) } } });
    expect((await call("GET", "/wiki/alice/note?path=none.md")).json.error.code).toBe("not_found");
    const huge = await app.inject({ method: "PUT", url: "/wiki/alice/note", headers: auth, payload: "x".repeat(4 * 1024 * 1024 + 1) });
    expect([huge.statusCode, JSON.parse(huge.body).error.code]).toEqual([413, "body_too_large"]);
  });

  it("키가 없거나 틀리면, 다른 표기의 경로로도 401이다", async () => {
    for (const url of ["/wiki/alice/notes", "/%77iki/alice/notes", "/wiki/alice/note?path=a.md", "/wiki/alice/search?q=x"]) {
      expect((await call("GET", url, undefined, {})).status, url).toBe(401);
      expect((await call("GET", url, undefined, { authorization: `Bearer ${"x".repeat(64)}` })).status, url).toBe(401);
    }
    expect((await call("DELETE", "/wiki/alice", undefined, {})).status).toBe(401);
    expect((await call("PUT", "/wiki/alice/note", { path: "pwn.md", content: "x" }, {})).status).toBe(401);
    expect((await call("GET", "/wiki/alice/note?path=pwn.md")).status).toBe(404);
  });
});
