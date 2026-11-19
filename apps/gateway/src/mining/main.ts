import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { openDefaultModel } from "../agent/runtime.js";
import { openDatabase } from "../db.js";
import { createLlm } from "./llm.js";
import { loadTargets, run } from "./run.js";
import { MINING_DB, MiningStore } from "./store.js";

/**
 * 실행 하나를 하는 프로세스. mining 서비스(service.ts)가 실행 id를 주고 띄운다: `node main.js <실행 id>`.
 * 결과는 그 실행 행에 적고, 로그는 stderr로 낸다. 로그에는 대화 내용을 찍지 않는다.
 */

// mining.db는 소유자만 읽게 한다.
process.umask(0o077);
const log = pino({ base: { service: "mining" } }, pino.destination({ dest: 2, sync: true }));
const runId = Number(process.argv[2]);
const store = new MiningStore(openDatabase(MINING_DB));

function fail(error: string): never {
  log.error(error);
  store.finishRun(runId, { status: "failed", error }, new Date().toISOString());
  process.exit(1);
}

// gateway DB는 읽기만 한다. openDatabase나 SessionStore로 열면 쓰기 연결이 되고 migrate가 돈다.
// 읽기 전용 mount에서는 gateway가 떠 있어야 열린다: WAL 파일(-wal, -shm)을 gateway가 만들어 두기 때문이다.
let targets: ReturnType<typeof loadTargets>;
let opened: Awaited<ReturnType<typeof openDefaultModel>>;
try {
  const gatewayDb = new Database(join(process.env.DATA_DIR || "/data", "gateway.db"), { readonly: true, fileMustExist: true });
  targets = loadTargets(gatewayDb);
  opened = await openDefaultModel(gatewayDb);
  // LLM을 부르는 동안 gateway DB를 잡고 있지 않는다.
  gatewayDb.close();
} catch (err) {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "could not read gateway.db");
  fail("gateway.db를 읽지 못했다 (gateway가 떠 있는지 확인한다)");
}
if (!opened) fail("LLM이 설정되어 있지 않다 (관리 화면의 LLM)");

const llm = createLlm(opened.runtime, opened.model, opened.config.maxTokens);
const result = await run({ targets, store, llm, log, runId });
log.info(result, "mining finished");
store.finishRun(
  runId,
  { status: result.status, processed: result.processed, failed: result.failed, remaining: result.remaining, episodes: result.episodeIds.length, model: llm.model },
  new Date().toISOString(),
);
// LLM 연결이 남아 있어도 끝낸다.
process.exit(0);
