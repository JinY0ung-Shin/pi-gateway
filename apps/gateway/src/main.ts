import pino from "pino";
import { createGateway } from "./app.js";
import { loadConfig } from "./config.js";

// gateway가 만드는 파일(DB, 세션 JSONL)은 소유자만 읽게 한다.
process.umask(0o077);
// pi가 모델 카탈로그·도구(rg, fd) 다운로드 같은 네트워크 접근을 하지 않게 한다.
process.env.PI_OFFLINE ??= "1";

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
