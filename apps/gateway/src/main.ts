import { createCachedLookup } from "@pi-gateway/shared";
import pino from "pino";
import { Agent, setGlobalDispatcher } from "undici";
import { createGateway } from "./app.js";
import { loadConfig } from "./config.js";

// gateway가 만드는 파일(DB, 세션 JSONL)은 소유자만 읽게 한다.
process.umask(0o077);
// broker·sandboxd·LLM으로 가는 연결이 이름을 매번 새로 찾지 않게 한다 (createCachedLookup).
setGlobalDispatcher(new Agent({ connect: { lookup: createCachedLookup() } }));

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  base: { service: "gateway" },
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.token"], censor: "[REDACTED]" },
});

const gateway = await createGateway(config, log);
await gateway.app.listen({ host: config.host, port: config.port });
log.info({ port: config.port, models: gateway.models.list().map((m) => m.id) }, "gateway listening");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  try {
    await gateway.close();
  } catch (err) {
    log.error({ err }, "shutdown failed");
  }
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
