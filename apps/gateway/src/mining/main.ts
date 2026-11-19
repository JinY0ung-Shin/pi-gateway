import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { openDefaultModel } from "../agent/runtime.js";
import { openDatabase } from "../db.js";
import { createLlm } from "./llm.js";
import { renderReport, REPORT_FILE } from "./report.js";
import { loadTargets, RECENT_MS, run } from "./run.js";
import { MiningStore } from "./store.js";

/**
 * mining 진입점 (compose의 `mining` 서비스). gateway와 다른 프로세스로 하루 한 번 돈다.
 * 보고서는 stdout과 REPORT_FILE로, 로그는 stderr로 낸다. 로그에는 대화 내용을 찍지 않는다.
 */

// mining.db와 보고서는 소유자만 읽게 한다.
process.umask(0o077);
const log = pino({ base: { service: "mining" } }, pino.destination({ dest: 2, sync: true }));

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
  log.error({ err: err instanceof Error ? err.message : String(err) }, "could not read gateway.db (is the gateway running?)");
  process.exit(1);
}
if (!opened) {
  log.error("LLM is not configured");
  process.exit(1);
}

const store = new MiningStore(openDatabase("/mining/mining.db"));
const llm = createLlm(opened.runtime, opened.model, opened.config.maxTokens);
const result = await run({ targets, store, llm, log });
log.info(result, "mining finished");

const at = new Date();
const report = renderReport({
  at,
  model: llm.model,
  result,
  labels: store.labels(),
  recent: store.recent(new Date(at.getTime() - RECENT_MS).toISOString()),
  touched: store.episodes(result.episodeIds),
  users: targets.users,
});
writeFileSync(REPORT_FILE, report);
process.stdout.write(report, () => process.exit(result.status === "aborted" ? 1 : 0));
