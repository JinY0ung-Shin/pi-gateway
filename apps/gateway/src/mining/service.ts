import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { openDatabase } from "../db.js";
import { cameDue, MINING_DB, MiningStore } from "./store.js";

/**
 * mining 서비스 (compose의 `mining`). 늘 떠서 실행 요청을 기다린다: 관리 화면의 "지금 실행"과, 매일 정한 시각의 자동 실행.
 * 실행은 main.ts를 자식 프로세스로 띄워서 한다. pi runtime은 실행하는 동안만 메모리에 있고, 실행이 죽어도 서비스는 남는다.
 */

const POLL_MS = 10_000;

{
  // mining.db는 소유자만 읽게 한다.
  process.umask(0o077);
  const log = pino({ base: { service: "mining" } }, pino.destination({ dest: 2, sync: true }));
  const store = new MiningStore(openDatabase(MINING_DB));
  const iso = () => new Date().toISOString();
  // 지난번에 실행하다 서비스가 내려갔다.
  store.finishRun(undefined, { status: "failed", error: "실행 중에 mining 서비스가 내려갔다" }, iso());

  let job: ReturnType<typeof spawn> | undefined;
  process.on("SIGTERM", () => {
    job?.kill();
    process.exit(0);
  });

  let checked = Date.now();
  for (;;) {
    const now = Date.now();
    const time = store.dailyAt();
    if (time && cameDue(time, checked, now)) store.requestRun("schedule", iso());
    checked = now;

    const id = store.startRun(iso());
    if (id !== undefined) {
      log.info({ run: id }, "mining run started");
      job = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), String(id)], { stdio: "inherit" });
      const code = await new Promise<number | null>((resolve) => job!.once("error", () => resolve(null)).once("exit", resolve));
      job = undefined;
      // 결과를 적지 못하고 죽었으면 여기서 닫는다.
      store.finishRun(id, { status: "failed", error: `실행 프로세스가 결과를 남기지 못하고 끝났다 (exit ${code})` }, iso());
      // 실행하는 동안 지나간 자동 실행 시각은 건너뛴다.
      checked = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
