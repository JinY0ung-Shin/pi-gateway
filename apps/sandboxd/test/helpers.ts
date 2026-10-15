import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUD_BROKER, AUD_SANDBOXD, jwtSecretBytes, signInternalToken } from "@pi-gateway/shared";
import pino from "pino";
import type { SandboxdConfig } from "../src/config.js";

export const SECRET_TEXT = "test-secret-test-secret-test-secret-42";
export const SECRET = jwtSecretBytes(SECRET_TEXT);
export const silentLogger = pino({ level: "silent" });

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function tokenFor(sub: string, opts: { secret?: Uint8Array; audience?: string } = {}): Promise<string> {
  return signInternalToken(opts.secret ?? SECRET, opts.audience ?? AUD_SANDBOXD, { sub });
}

export async function brokerTokenFor(sub: string): Promise<string> {
  return signInternalToken(SECRET, AUD_BROKER, { sub });
}

/** 테스트용 sandboxd 설정 */
export function testConfig(overrides: Partial<SandboxdConfig> = {}): SandboxdConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    jwtSecret: SECRET,
    dockerSocket: "/var/run/docker.sock",
    image: "pi-gateway/sandbox:test",
    proxyVolume: "pi-gw-test-proxy-sock",
    runtime: undefined,
    workspacesDir: "/srv/workspaces",
    workspacesHostDir: "/host/workspaces",
    pluginsHostDir: "/host/plugins",
    memoryBytes: 512 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    tmpSize: "64m",
    shmSizeBytes: 64 * 1024 * 1024,
    idleSeconds: 900,
    reapIntervalMs: 60_000,
    containerPrefix: "pi-sbx-test-",
    instance: "unit",
    fsTimeoutSeconds: 60,
    ...overrides,
  };
}
