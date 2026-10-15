import { pino } from "pino";
import type { GatewayConfig } from "../config.js";

/** platform 레인 모듈이 쓰는 최소 logger 인터페이스 (pino·Fastify logger와 호환) */
export interface PlatformLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const loggers = new Map<string, PlatformLogger>();

export function platformLogger(config: Pick<GatewayConfig, "logLevel">, name: string): PlatformLogger {
  const key = `${config.logLevel}:${name}`;
  let logger = loggers.get(key);
  if (!logger) {
    logger = pino({ level: config.logLevel, name: `pi-gateway:${name}` });
    loggers.set(key, logger);
  }
  return logger;
}
