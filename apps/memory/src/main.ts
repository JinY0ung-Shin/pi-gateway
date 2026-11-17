import { createLogger, createMemoryService } from "./app.js";
import { loadMemoryConfig } from "./config.js";

// 이 서비스가 만드는 파일(노트)은 이 서비스의 uid만 읽을 수 있게 한다.
process.umask(0o077);

const log = createLogger(process.env.LOG_LEVEL ?? "info");
const config = loadMemoryConfig();
const app = createMemoryService(config, { log });

await app.listen({ host: config.host, port: config.port });
log.info({ port: config.port }, "memory listening");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
