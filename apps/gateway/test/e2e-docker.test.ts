// gateway → 실제 sandboxd → Docker 사용자 컨테이너까지 전체 흐름. PI_GW_DOCKER_TESTS=1 일 때만 돈다.
//   PI_GW_DOCKER_TESTS=1 npx vitest run apps/gateway/test/e2e-docker.test.ts
// 이미지: SANDBOX_TEST_IMAGE (기본 pi-gateway/sandbox:test, 없으면 images/sandbox에서 빌드한다)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServerConfig } from "@pi-gateway/shared";
import Docker from "dockerode";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureProxyVolume } from "../../sandboxd/src/docker-setup.js";
import { SandboxManager } from "../../sandboxd/src/manager.js";
import { DockerSandboxRuntime } from "../../sandboxd/src/runtime.js";
import { buildServer } from "../../sandboxd/src/server.js";
import { LABEL_INSTANCE } from "../../sandboxd/src/spec.js";
import { Workspaces } from "../../sandboxd/src/workspace.js";
import { SECRET_TEXT, silentLogger, tempDir, testConfig } from "../../sandboxd/test/helpers.js";
import { BOB_KEY, type Harness, last, ofType, startHarness } from "./helpers.js";

const enabled = process.env.PI_GW_DOCKER_TESTS === "1";
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "pi-gateway/sandbox:test";
const REPO = resolve(import.meta.dirname, "../../..");
const run = randomBytes(4).toString("hex");

let docker: Docker;
let sandboxd: FastifyInstance | undefined;
let wsRoot: string | undefined;
let pluginsDir: string | undefined;
let h: Harness | undefined;

/** 임시 디렉토리를 지운다. 현재 사용자가 못 지우는 파일(다른 uid 소유)이 있으면 Docker로 root 권한으로 지운다. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    /* 아래에서 다시 시도 */
  }
  try {
    execFileSync(
      "docker",
      ["run", "--rm", "--user", "0", "--network", "none", "--entrypoint", "sh", "-v", `${dir}:/target`, IMAGE, "-c", "rm -rf /target/* /target/.[!.]* /target/..?*"],
      { stdio: "ignore" },
    );
  } catch {
    /* 마지막으로 rmSync를 한 번 더 */
  }
  rmSync(dir, { recursive: true, force: true });
}

/** bash 도구를 한 번 호출하게 하고 결과 텍스트를 돌려준다 */
async function bash(command: string, key?: string, extra: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  h!.llm.enqueue({ toolCalls: [{ id: `b_${randomBytes(3).toString("hex")}`, name: "bash", arguments: { command } }] }, { text: "done" });
  const res = await h!.stream({ input: `run: ${command}`, ...extra }, key ? { key } : undefined);
  const result = ofType(res.events, "response.tool_result")[0]!.data;
  return { text: String(result.content), isError: result.is_error === true };
}

describe.skipIf(!enabled)("gateway + sandboxd + Docker", () => {
  beforeAll(async () => {
    docker = new Docker({ socketPath: "/var/run/docker.sock" });
    try {
      await docker.getImage(IMAGE).inspect();
    } catch {
      execFileSync("docker", ["build", "-q", "-t", IMAGE, join(REPO, "images/sandbox")], { stdio: "inherit" });
    }
    wsRoot = tempDir("pi-gw-e2e-ws-");
    pluginsDir = tempDir("pi-gw-e2e-plugins-");
    copyFileSync(fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url)), join(pluginsDir, "stdio-mcp-server.mjs"));
    const config = testConfig({
      image: IMAGE,
      proxyVolume: `pi-gw-e2e-proxy-${run}`,
      workspacesDir: wsRoot,
      workspacesHostDir: wsRoot,
      pluginsHostDir: pluginsDir,
      instance: `e2e-${run}`,
      containerPrefix: `pi-sbx-e2e-${run}-`,
      idleSeconds: 120,
    });
    await ensureProxyVolume(docker, config, silentLogger);
    const manager = new SandboxManager(docker, config, new Workspaces(wsRoot), silentLogger);
    const runtime = new DockerSandboxRuntime(manager, config, silentLogger);
    sandboxd = await buildServer({ jwtSecret: config.jwtSecret, runtime, logger: silentLogger });
    await sandboxd.listen({ host: "127.0.0.1", port: 0 });
    const sandboxdUrl = `http://127.0.0.1:${(sandboxd.server.address() as AddressInfo).port}`;
    h = await startHarness({
      sandboxd: { url: sandboxdUrl, secret: SECRET_TEXT },
      env: { LLM_API_KEY: "llm-secret-should-never-reach-the-sandbox" },
      sandboxServers: [
        McpServerConfig.parse({
          id: "local",
          runIn: "sandbox",
          scope: "per-session",
          transport: { type: "stdio", command: "node", args: ["/opt/plugins/stdio-mcp-server.mjs"], env: { THREAD_ID: "{{metadata:thread_id}}" } },
        }),
      ],
    });
  }, 600_000);

  // 실패한 경우에도 돈다 (beforeAll이 중간에 실패해도). 각 단계는 앞 단계 실패와 상관없이 실행한다.
  afterAll(async () => {
    await h?.close().catch(() => undefined);
    await sandboxd?.close().catch(() => undefined);
    if (docker) {
      const leftovers = await docker.listContainers({ all: true, filters: { label: [`${LABEL_INSTANCE}=e2e-${run}`] } }).catch(() => []);
      await Promise.all(leftovers.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)));
      await docker.getVolume(`pi-gw-e2e-proxy-${run}`).remove().catch(() => undefined);
    }
    // sandbox가 uid 1000으로 만든 파일이 있어 removeDir가 필요하면 root 컨테이너로 지운다
    for (const dir of [wsRoot, pluginsDir]) if (dir) removeDir(dir);
  }, 120_000);

  it("bash runs as the unprivileged sandbox user in its own container", async () => {
    const out = await bash("id -u; whoami; hostname; pwd; wc -l < /etc/passwd");
    expect(out.isError).toBe(false);
    const [uid, name, host, pwd, passwdLines] = out.text.trim().split("\n");
    expect(uid).toBe("1000");
    expect(name).toBe("agent");
    expect(host).toBe("sandbox");
    expect(pwd).toBe("/workspace");
    expect(Number(passwdLines)).toBeLessThanOrEqual(3);
  }, 120_000);

  it("gateway secrets never reach the sandbox environment or /proc", async () => {
    const out = await bash("env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; ls /run/secrets 2>&1; ls -la /var/run/docker.sock 2>&1");
    expect(out.text).not.toContain("llm-secret-should-never-reach-the-sandbox");
    expect(out.text).not.toContain(SECRET_TEXT);
    expect(out.text).not.toMatch(/SANDBOXD_JWT_SECRET|BROKER_JWT_SECRET|USER_API_KEYS|ADMIN_API_KEY/);
    expect(out.text).toContain("No such file or directory");
  }, 120_000);

  it("file tools and grep work against the container workspace", async () => {
    h!.llm.enqueue(
      { toolCalls: [{ id: "w1", name: "write", arguments: { path: "src/app.py", content: "print('needle')\n" } }] },
      { toolCalls: [{ id: "g1", name: "grep", arguments: { pattern: "needle" } }] },
      { toolCalls: [{ id: "f1", name: "find", arguments: { pattern: "**/*.py" } }] },
      { toolCalls: [{ id: "r1", name: "read", arguments: { path: "/workspace/src/app.py" } }] },
      { text: "done" },
    );
    const res = await h!.stream({ input: "files" });
    const results = ofType(res.events, "response.tool_result").map((e) => e.data);
    expect(results.every((r) => r.is_error === false)).toBe(true);
    expect(String(results[1]!.content)).toContain("src/app.py:1: print('needle')");
    expect(String(results[2]!.content)).toContain("src/app.py");
    expect(String(results[3]!.content)).toContain("print('needle')");
    expect(last(res.events).type).toBe("response.completed");
  }, 120_000);

  it("users cannot see each other's workspaces", async () => {
    await bash("echo top-secret > alice-secret.txt && ls");
    const bob = await bash("ls -la /workspace; find / -name alice-secret.txt 2>/dev/null; echo end", BOB_KEY);
    expect(bob.text).not.toContain("alice-secret.txt");
    expect(bob.text).toContain("end");
  }, 120_000);

  it("sandbox MCP servers run inside the user's container with system binaries only", async () => {
    // agent가 workspace에 가짜 node를 심어도 MCP 서버는 시스템 node로 뜬다
    const planted = await bash(
      'for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" /workspace/bin; do mkdir -p "$d"; printf "#!/bin/sh\necho hijacked >&2; exit 1\n" > "$d/node"; chmod +x "$d/node"; done; echo "$PATH"',
    );
    expect(planted.isError).toBe(false);
    h!.llm.enqueue({ toolCalls: [{ id: "m1", name: "mcp__local__whoami", arguments: {} }] }, { text: "done" });
    const res = await h!.stream({ input: "who", metadata: { thread_id: "thread-77" } });
    const result = ofType(res.events, "response.tool_result")[0]!.data;
    expect(result.is_error).toBe(false);
    expect(String(result.content)).toBe("thread=thread-77 cwd=/workspace");
  }, 120_000);
});
