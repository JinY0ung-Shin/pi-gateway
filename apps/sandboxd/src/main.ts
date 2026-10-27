import { stat } from "node:fs/promises";
import Docker from "dockerode";
import pino from "pino";
import { loadConfig } from "./config.js";
import { SandboxManager } from "./manager.js";
import { DockerSandboxRuntime } from "./runtime.js";
import { buildServer } from "./server.js";
import { Workspaces } from "./workspace.js";

// sandboxd가 만드는 파일·디렉토리는 소유자만 읽게 한다
process.umask(0o077);

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "sandboxd" } });

const root = await stat(config.workspacesDir).catch(() => null);
if (!root?.isDirectory()) {
  log.fatal({ dir: config.workspacesDir }, "WORKSPACES_DIR does not exist");
  process.exit(1);
}

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
await docker.ping();

const workspaces = new Workspaces(config.workspacesDir);
const manager = new SandboxManager(docker, config, workspaces, log);
await manager.reconcile();
manager.startReaper();

const runtime = new DockerSandboxRuntime(manager, config, log);
const app = await buildServer({ jwtSecret: config.jwtSecret, runtime, logger: log });
await app.listen({ host: "0.0.0.0", port: config.port });
log.info(
  { port: config.port, image: config.image, proxyVolume: config.proxyVolume, idleSeconds: config.idleSeconds },
  "sandboxd listening",
);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  manager.stopReaper();
  // sandbox 컨테이너는 남겨 둔다. 다음 시작 때 reconcile이 다시 채택한다.
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
