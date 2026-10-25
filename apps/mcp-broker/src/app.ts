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
import { connectUpstream } from "./upstream/connect.js";

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

export function createBroker(config: BrokerConfig, options: { log?: Logger; db?: Db } = {}): Broker {
  const log = options.log ?? createLogger(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = options.db ?? openDatabase(join(config.dataDir, "broker.db"));
  const store = new BrokerStore(db, new SecretCipher(config.kek));
  const pool = new UpstreamPool({
    limits: config.limits,
    log,
    connect: (rendered, hooks) => connectUpstream(rendered, { connectTimeoutMs: config.limits.connectTimeoutSeconds * 1000, hooks }),
  });
  const service = new BrokerService({ store, pool, config, log });
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
