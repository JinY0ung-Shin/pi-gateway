import { readFileSync } from "node:fs";
import { SANDBOXD_ROUTES } from "@pi-gateway/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../src/db.js";
import { type Harness, last, ofType, SERVICE_KEY, startHarness } from "./helpers.js";

const SECRET = "tok_Sup3r-S3cret+value/42";
const sessionOf = (id: string) => /^resp_(.+)_\d+$/.exec(id)![1]!;

let h: Harness;
let db: Db;

beforeAll(async () => {
  db = openDatabase(":memory:");
  h = await startHarness({ overrides: { db } });
});
afterAll(async () => {
  await h?.close();
});

const execsWith = (marker: string) => h.sandbox.calls.filter((c) => c.route === SANDBOXD_ROUTES.exec && JSON.stringify(c.body.argv).includes(marker));

/** gateway DB의 모든 테이블 내용 */
const dbDump = () =>
  JSON.stringify(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()),
  );

describe("sandbox_env", () => {
  it("reaches bash, is redacted from every tool result, and is never persisted", async () => {
    h.llm.enqueue(
      { toolCalls: [{ id: "env_1", name: "bash", arguments: { command: 'echo "v=$MY_TOKEN"; printf %s "$MY_TOKEN" | base64; printf %s "$MY_TOKEN" > tok.txt' } }] },
      { toolCalls: [{ id: "env_2", name: "read", arguments: { path: "tok.txt" } }] },
      { toolCalls: [{ id: "env_3", name: "bash", arguments: { command: 'echo "$MY_TOKEN"; exit 2' } }] },
      { text: "done" },
    );
    const res = await h.stream({ input: "use the token", user: "alice", sandbox_env: { MY_TOKEN: SECRET } }, { key: SERVICE_KEY });
    expect(last(res.events).type).toBe("response.completed");

    const exec = execsWith("v=$MY_TOKEN")[0]!;
    expect(exec.body.env).toEqual({ MY_TOKEN: SECRET });

    const results = ofType(res.events, "response.tool_result").map((e) => String(e.data.content));
    expect(results).toHaveLength(3);
    for (const content of results) expect(content).toContain("[REDACTED]");
    expect(results[0]).toContain("v=[REDACTED]");
    // 스트림 전체(진행 상황 포함)·모델이 받은 대화·세션 JSONL·DB 어디에도 원문도 base64도 없다
    const encoded = Buffer.from(SECRET).toString("base64");
    // response.completed의 response는 응답 본문이다
    const completed = last(res.events).data.response as { id: string };
    const sid = sessionOf(completed.id);
    const transcript = readFileSync(h.gateway.store.get(sid)!.sessionFile!, "utf8");
    for (const where of [res.raw, JSON.stringify(h.llm.requests.at(-1)!.messages), transcript, dbDump()]) {
      expect(where).not.toContain(SECRET);
      expect(where).not.toContain(encoded);
    }

    // 다음 요청이 보내지 않으면 그 턴의 bash에는 아무것도 들어가지 않는다 (gateway는 저장하지 않는다).
    h.llm.enqueue({ toolCalls: [{ id: "env_4", name: "bash", arguments: { command: "echo next-turn" } }] }, { text: "ok" });
    const next = await h.post({ input: "again", user: "alice", previous_response_id: completed.id }, { key: SERVICE_KEY });
    expect(next.status).toBe(200);
    expect(execsWith("next-turn")[0]!.body.env).toBeUndefined();
  });

  it("is rejected for user-key requests and reserved names", async () => {
    const userKey = await h.post({ input: "x", sandbox_env: { MY_TOKEN: SECRET } });
    expect(userKey.status).toBe(403);
    expect(userKey.json.error.code).toBe("sandbox_env_not_allowed");

    for (const name of ["PATH", "https_proxy", "LD_PRELOAD", "1BAD"]) {
      const res = await h.post({ input: "x", user: "alice", sandbox_env: { [name]: SECRET } }, { key: SERVICE_KEY });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).not.toContain(SECRET);
    }
  });
});
