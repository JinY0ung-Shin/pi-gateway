import { createBroker, createLogger } from "./app.js";
import { ALLOW_INSECURE_SECRET_FILES, auditSecretFiles, loadBrokerConfig } from "./config.js";

// broker가 만드는 파일(DB, 작업 디렉토리)은 broker uid만 읽을 수 있게 한다.
process.umask(0o077);

const log = createLogger(process.env.LOG_LEVEL ?? "info");
const audit = auditSecretFiles(process.env);
for (const warning of audit.warnings) log.warn(warning);
if (audit.problems.length > 0) {
  if (process.env[ALLOW_INSECURE_SECRET_FILES] === "1") {
    log.warn({ problems: audit.problems }, `insecure secret files; continuing because ${ALLOW_INSECURE_SECRET_FILES}=1`);
  } else {
    log.fatal(
      { problems: audit.problems },
      `refusing to start: secret files must be owned by the broker uid and not accessible by group/other (set ${ALLOW_INSECURE_SECRET_FILES}=1 to override)`,
    );
    process.exit(1);
  }
}

const config = loadBrokerConfig();
const broker = createBroker(config, { log });

await broker.dataPlane.listen({ host: config.host, port: config.port });
await broker.adminPlane.listen({ host: config.adminHost, port: config.adminPort });
log.info({ port: config.port, adminPort: config.adminPort }, "mcp-broker listening");

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await broker.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
