import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import { buildAdminPlane } from "./admin-plane.js";
import type { BrokerConfig } from "./config.js";
import { SecretCipher } from "./crypto.js";
import { buildDataPlane } from "./data-plane.js";
import { type Db, openDatabase } from "./db.js";
import { UpstreamPool } from "./pool.js";
import { BrokerService } from "./service.js";
import { BrokerStore } from "./store.js";
import { connectUpstream, type StdioRuntime, UidAllocator } from "./upstream/connect.js";

export interface Broker {
  config: BrokerConfig;
  store: BrokerStore;
  service: BrokerService;
  pool: UpstreamPool;
  dataPlane: FastifyInstance;
  adminPlane: FastifyInstance;
  log: Logger;
  /** graceMs가 지나도 끝나지 않은 HTTP 연결은 강제로 끊는다. */
  close(graceMs?: number): Promise<void>;
}

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: "mcp-broker" },
    redact: { paths: ["req.headers.authorization", "headers.authorization", "*.authorization"], censor: "[REDACTED]" },
  });
}

/**
 * stdio 자식을 다른 uid로 띄울 수 있는지 실제로 확인한다.
 * uid 범위를 설정했는데 안 되면 시작하지 않는다 (fail closed).
 */
export function assertUidSwitching(range: { start: number; end: number }): void {
  const probe = spawnSync(process.execPath, ["-e", "process.exit(process.getuid() === Number(process.argv[1]) ? 0 : 3)", String(range.start)], {
    uid: range.start,
    gid: range.start,
    env: {},
    cwd: "/",
    stdio: "ignore",
    timeout: 10_000,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `BROKER_STDIO_UID_RANGE is set but spawning as uid ${range.start} failed (${probe.error?.message ?? `exit ${probe.status}`}); ` +
        "run the broker as root with cap_add SETUID, SETGID, CHOWN, KILL (DAC_OVERRIDE recommended) or unset the range",
    );
  }
}

export function createBroker(config: BrokerConfig, options: { log?: Logger; db?: Db } = {}): Broker {
  const log = options.log ?? createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // uid가 다른 자식이 자기 디렉토리까지만 내려갈 수 있게 한다.
  mkdirSync(config.stdio.workRoot, { recursive: true, mode: 0o711 });

  if (config.stdio.uidRange) assertUidSwitching(config.stdio.uidRange);
  else log.warn("BROKER_STDIO_UID_RANGE is not set: stdio MCP servers run as the broker uid and are not isolated from each other");

  const db = options.db ?? openDatabase(join(config.dataDir, "broker.db"));
  const store = new BrokerStore(db, new SecretCipher(config.kek));
  const stdio: StdioRuntime = {
    path: config.stdio.path,
    lang: config.stdio.lang,
    workRoot: config.stdio.workRoot,
    maxMessageBytes: config.stdio.maxMessageBytes,
    uids: config.stdio.uidRange ? new UidAllocator(config.stdio.uidRange) : null,
    onUidQuarantined: (uid) =>
      log.error({ uid }, "processes of a stdio uid survived cleanup; the uid is quarantined and will not be reused"),
  };
  const pool = new UpstreamPool({
    limits: config.limits,
    log,
    connect: (rendered, hooks) =>
      connectUpstream(rendered, { connectTimeoutMs: config.limits.connectTimeoutSeconds * 1000, stdio, hooks }),
  });
  const service = new BrokerService({ store, pool, config, log, stdio });
  const dataPlane = buildDataPlane({ config, service, log });
  const adminPlane = buildAdminPlane({ config, store, service, log });

  let closed = false;
  return {
    config,
    store,
    service,
    pool,
    dataPlane,
    adminPlane,
    log,
    async close(graceMs = 5000) {
      if (closed) return;
      closed = true;
      // 진행 중인 요청은 graceMs까지 기다린다. 그 뒤에도 남은 연결은 끊는다.
      // (요청 없이 열린 keep-alive 연결이나, 헤더를 보내다 만 연결은 Node가 headersTimeout(60초)까지 붙잡는다.)
      const force = setTimeout(() => {
        dataPlane.server.closeAllConnections();
        adminPlane.server.closeAllConnections();
      }, graceMs);
      force.unref();
      await Promise.allSettled([dataPlane.close(), adminPlane.close()]);
      clearTimeout(force);
      await pool.closeAll();
      db.close();
    },
  };
}
