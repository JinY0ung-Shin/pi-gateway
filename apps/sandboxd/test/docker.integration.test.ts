// 실제 Docker로 sandboxd를 시험한다. PI_GW_DOCKER_TESTS=1 일 때만 돈다.
//   PI_GW_DOCKER_TESTS=1 npx vitest run apps/sandboxd/test/docker.integration.test.ts
// 이미지: SANDBOX_TEST_IMAGE (기본 pi-gateway/sandbox:test, 없으면 images/sandbox에서 빌드한다)
//         EGRESS_PROXY_TEST_IMAGE (기본 pi-gateway/egress-proxy:test, 없으면 Dockerfile의 egress-proxy target으로 빌드한다)
// egress 시험은 인터넷(https://example.com)이 필요하다.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import {
  ADMIN_PRINCIPAL,
  type ExecEvent,
  type ExecRequest,
  SANDBOXD_ROUTES,
  userKey,
} from "@pi-gateway/shared";
import Docker from "dockerode";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { SandboxdConfig } from "../src/config.js";
import { SandboxManager } from "../src/manager.js";
import { DockerSandboxRuntime } from "../src/runtime.js";
import { buildServer } from "../src/server.js";
import { containerName, LABEL_INSTANCE } from "../src/spec.js";
import { Workspaces } from "../src/workspace.js";
import { silentLogger, tempDir, testConfig, tokenFor } from "./helpers.js";

const enabled = process.env.PI_GW_DOCKER_TESTS === "1";
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "pi-gateway/sandbox:test";
const PROXY_IMAGE = process.env.EGRESS_PROXY_TEST_IMAGE ?? "pi-gateway/egress-proxy:test";
const REPO = resolve(import.meta.dirname, "../../..");

const run = randomBytes(4).toString("hex");
let docker: Docker;
let config: SandboxdConfig;
let wsRoot: string;
let pluginsDir: string;
let manager: SandboxManager;
let app: FastifyInstance;
let base: string;
/** egress 프록시가 있는 Docker 기본 bridge의 gateway (= 호스트) 주소 */
let hostGw: string;

async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    execFileSync("docker", ["build", "-q", "-t", IMAGE, join(REPO, "images/sandbox")], { stdio: "inherit" });
  }
  try {
    await docker.getImage(PROXY_IMAGE).inspect();
  } catch {
    execFileSync("docker", ["build", "-q", "--target", "egress-proxy", "-t", PROXY_IMAGE, REPO], { stdio: "inherit" });
  }
}

/** compose의 egress-proxy와 같은 설정으로 프록시를 띄운다. 기본 bridge에 붙어 허용 목록의 목적지로 나간다. */
async function startEgressProxy(): Promise<void> {
  hostGw = ((await docker.getNetwork("bridge").inspect()) as { IPAM: { Config: { Gateway: string }[] } }).IPAM.Config[0]!.Gateway;
  const proxy = await docker.createContainer({
    name: `pi-gw-test-proxy-${run}`,
    Image: PROXY_IMAGE,
    // 허용 목록: 도메인 example.com의 443, 호스트의 포트 9. 나머지는 모두 거부한다
    Env: [`SANDBOX_EGRESS_ALLOW=example.com:443,${hostGw}:9`],
    Labels: { [LABEL_INSTANCE]: `it-${run}` },
    HostConfig: {
      Init: true,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Mounts: [{ Type: "volume", Source: config.proxyVolume, Target: "/run/pi-proxy" }],
    },
  });
  await proxy.start();
}

async function headers(sub: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await tokenFor(sub)}`, "content-type": "application/json" };
}

async function post(route: string, user: string, body: object): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: await headers(user),
    body: JSON.stringify({ user, ...body }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  events: ExecEvent[];
  exit: Extract<ExecEvent, { type: "exit" }>;
  ms: number;
}

async function exec(user: string, req: Omit<ExecRequest, "user">, signal?: AbortSignal): Promise<ExecOutcome> {
  const t0 = Date.now();
  const init: RequestInit = { method: "POST", headers: await headers(user), body: JSON.stringify({ user, ...req }) };
  if (signal) init.signal = signal;
  const res = await fetch(`${base}${SANDBOXD_ROUTES.exec}`, init);
  expect(res.status).toBe(200);
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ExecEvent);
  const text = (type: "stdout" | "stderr") =>
    Buffer.concat(events.flatMap((e) => (e.type === type ? [Buffer.from(e.data, "base64")] : []))).toString();
  const exit = events.find((e) => e.type === "exit") as Extract<ExecEvent, { type: "exit" }>;
  return { stdout: text("stdout"), stderr: text("stderr"), events, exit, ms: Date.now() - t0 };
}

const sh = (user: string, script: string, extra: Partial<ExecRequest> = {}) =>
  exec(user, { argv: ["bash", "-c", script], ...extra });

describe.skipIf(!enabled)("sandboxd + Docker", () => {
  beforeAll(async () => {
    docker = new Docker({ socketPath: "/var/run/docker.sock" });
    await ensureImage();
    wsRoot = tempDir("pi-gw-ws-");
    pluginsDir = tempDir("pi-gw-plugins-");
    writeFileSync(join(pluginsDir, "SKILL.md"), "# shared skill\n");
    config = testConfig({
      image: IMAGE,
      proxyVolume: `pi-gw-test-proxy-${run}`,
      workspacesDir: wsRoot,
      workspacesHostDir: wsRoot,
      pluginsHostDir: pluginsDir,
      instance: `it-${run}`,
      containerPrefix: `pi-sbx-it-${run}-`,
      idleSeconds: 60,
    });
    await startEgressProxy();
    manager = new SandboxManager(docker, config, new Workspaces(wsRoot), silentLogger);
    const runtime = new DockerSandboxRuntime(manager, config, silentLogger);
    app = await buildServer({ jwtSecret: config.jwtSecret, runtime, logger: silentLogger });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    const leftovers = await docker.listContainers({ all: true, filters: { label: [`${LABEL_INSTANCE}=it-${run}`] } });
    await Promise.all(leftovers.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)));
    await docker.getVolume(`pi-gw-test-proxy-${run}`).remove().catch(() => undefined);
    for (const d of [wsRoot, pluginsDir]) {
      if (!d) continue;
      execFileSync("chmod", ["-R", "u+rwx", d]);
      rmSync(d, { recursive: true, force: true });
    }
  }, 120_000);

  it("ensure가 보안 옵션이 적용된 컨테이너를 만든다", async () => {
    const res = await post(SANDBOXD_ROUTES.ensure, "alice", {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ key: userKey("alice"), state: "running", created: true });
    const info = await docker.getContainer(containerName(config, userKey("alice"))).inspect();
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(info.HostConfig.Privileged).toBe(false);
    expect(info.Config.User).toBe("1000:1000");
    expect(info.Mounts.map((m) => `${m.Destination}:${m.RW ? "rw" : "ro"}`).sort()).toEqual([
      "/opt/plugins:ro",
      "/run/pi-proxy:ro",
      "/workspace:rw",
    ]);
    expect(info.HostConfig.NetworkMode).toBe("none");
    const again = await post(SANDBOXD_ROUTES.ensure, "alice", {});
    expect(again.json.created).toBe(false);
  });

  it("출력을 stdout/stderr로 나눠 흘려보내고 종료 코드를 준다", async () => {
    const r = await sh("alice", "echo out; echo err >&2; id -u; pwd; exit 3");
    expect(r.events[0]).toMatchObject({ type: "started" });
    expect(r.stdout).toBe("out\n1000\n/workspace\n");
    expect(r.stderr).toBe("err\n");
    expect(r.exit).toMatchObject({ exitCode: 3, signal: null, timedOut: false, truncated: false });
  });

  it("cwd, env, stdin을 전달한다", async () => {
    await sh("alice", "mkdir -p /workspace/sub");
    const r = await exec("alice", {
      argv: ["bash", "-c", 'pwd; echo "$FOO"; cat'],
      cwd: "sub",
      env: { FOO: "bar" },
      stdin: Buffer.from("from-stdin").toString("base64"),
    });
    expect(r.stdout).toBe("/workspace/sub\nbar\nfrom-stdin");
    const missing = await exec("alice", { argv: ["true"], cwd: "/does/not/exist" });
    expect(missing.exit.exitCode).toBe(1);
    expect(missing.stderr).toContain("cannot change directory");
  });

  it("timeout이면 process group을 끝내고 timedOut을 표시한다", async () => {
    const r = await exec("alice", { argv: ["bash", "-c", "sleep 60 & sleep 60"], timeoutSec: 1 });
    expect(r.exit).toMatchObject({ timedOut: true, exitCode: null, signal: "SIGTERM" });
    expect(r.ms).toBeLessThan(8000);
    const ps = await sh("alice", "ps -eo comm | grep -c '^sleep' || true");
    // sleep은 하나도 남지 않는다 (컨테이너의 메인 프로세스는 sbx-proxy-bridge)
    expect(ps.stdout.trim()).toBe("0");
  });

  it("클라이언트가 끊으면 process group을 끝낸다", async () => {
    const controller = new AbortController();
    const pending = exec("alice", { argv: ["bash", "-c", "echo ready; sleep 120"] }, controller.signal).catch(
      (err: unknown) => err,
    );
    await new Promise((r) => setTimeout(r, 1000));
    controller.abort();
    await pending;
    let count = "";
    for (let i = 0; i < 40; i++) {
      count = (await sh("alice", "ps -eo args | grep -c '^sleep 120' || true")).stdout.trim();
      if (count === "0") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(count).toBe("0");
  });

  it("출력이 maxOutputBytes를 넘으면 자르고 truncated를 표시한다", async () => {
    const r = await exec("alice", { argv: ["bash", "-c", "head -c 200000 /dev/zero | tr '\\0' a"], maxOutputBytes: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.exit.truncated).toBe(true);
    expect(r.exit.exitCode).toBe(0);
  });

  it("/tmp와 /workspace에서 스크립트를 실행할 수 있다", async () => {
    const r = await sh(
      "alice",
      "printf '#!/bin/sh\\necho ok\\n' > /tmp/s.sh && chmod +x /tmp/s.sh && /tmp/s.sh && cp /tmp/s.sh /workspace/s.sh && /workspace/s.sh",
    );
    expect(r.stdout).toBe("ok\nok\n");
  });

  it("workspace에 심어 둔 같은 이름의 실행 파일이 시스템 명령과 sandboxd 도우미를 가리지 못한다", async () => {
    const names = ["node", "timeout", "fdfind", "fd", "bash", "sh", "python3", "kill"];
    await sh(
      "mallory",
      `for d in /workspace/.home/.local/bin /workspace/.home/.npm-global/bin; do mkdir -p $d; for n in ${names.join(" ")}; do printf '#!/bin/sh\\necho HIJACK > /workspace/hijacked-%s\\n' "$n" > $d/$n; chmod +x $d/$n; done; done`,
    );
    const which = await sh("mallory", "command -v node timeout bash python3 fdfind; echo \"$PATH\"");
    expect(which.stdout.split("\n").slice(0, 5)).toEqual([
      "/usr/local/bin/node",
      "/usr/bin/timeout",
      "/usr/bin/bash",
      "/usr/local/bin/python3",
      "/usr/bin/fdfind",
    ]);
    expect(which.stdout).toContain("/usr/local/bin:/usr/bin:/bin:/workspace/.home/.local/bin");
    // sandboxd 도우미: fs 조작(timeout + sbx-fs), glob(fd), timeout 시 process group kill(sbx-run kill)
    await post(SANDBOXD_ROUTES.fsWrite, "mallory", { path: "x/a.txt", content: Buffer.from("a").toString("base64") });
    expect((await post(SANDBOXD_ROUTES.fsRead, "mallory", { path: "x/a.txt" })).status).toBe(200);
    expect((await post(SANDBOXD_ROUTES.fsGlob, "mallory", { pattern: "*.txt" })).json.paths).toContain("/workspace/x/a.txt");
    const timed = await exec("mallory", { argv: ["sleep", "30"], timeoutSec: 1 });
    expect(timed.exit.timedOut).toBe(true);
    const planted = await sh("mallory", "ls /workspace | grep '^hijacked-' || true");
    expect(planted.stdout).toBe("");
  });

  it("백그라운드 프로세스가 pipe를 쥐고 있어도 바로 돌아온다", async () => {
    const r = await sh("alice", "sleep 30 & echo started");
    expect(r.stdout).toBe("started\n");
    expect(r.ms).toBeLessThan(3000);
  });

  it("파일 조작: binary 쓰기·읽기, stat, list, mkdir, glob(.gitignore 존중), 오류 매핑", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    const w = await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "data/bin.dat", content: bytes.toString("base64") });
    expect(w).toEqual({ status: 200, json: { size: 6 } });
    const r = await post(SANDBOXD_ROUTES.fsRead, "alice", { path: "/workspace/data/bin.dat" });
    expect(Buffer.from(r.json.content, "base64")).toEqual(bytes);
    const part = await post(SANDBOXD_ROUTES.fsRead, "alice", { path: "data/bin.dat", maxBytes: 2 });
    expect(part.json).toMatchObject({ size: 6, truncated: true });
    expect(Buffer.from(part.json.content, "base64")).toEqual(bytes.subarray(0, 2));

    expect((await post(SANDBOXD_ROUTES.fsStat, "alice", { path: "data" })).json).toMatchObject({
      exists: true,
      kind: "dir",
      targetIsDir: true,
    });
    expect((await post(SANDBOXD_ROUTES.fsStat, "alice", { path: "nope" })).json).toEqual({ exists: false });
    expect((await post(SANDBOXD_ROUTES.fsMkdir, "alice", { path: "data/x/y" })).status).toBe(200);
    expect((await post(SANDBOXD_ROUTES.fsList, "alice", { path: "data" })).json).toEqual({
      entries: [
        { name: "bin.dat", kind: "file" },
        { name: "x", kind: "dir" },
      ],
    });

    await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "g/keep.txt", content: "" });
    await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "g/ignored.txt", content: "" });
    await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "g/node_modules/dep.txt", content: "" });
    await post(SANDBOXD_ROUTES.fsWrite, "alice", {
      path: "g/.gitignore",
      content: Buffer.from("ignored.txt\n").toString("base64"),
    });
    const glob = await post(SANDBOXD_ROUTES.fsGlob, "alice", {
      cwd: "/workspace/g",
      pattern: "*.txt",
      ignore: ["**/node_modules/**"],
    });
    expect(glob.json).toEqual({ paths: ["/workspace/g/keep.txt"], truncated: false });
    const nested = await post(SANDBOXD_ROUTES.fsGlob, "alice", { pattern: "data/**/*.dat" });
    expect(nested.json.paths).toEqual(["/workspace/data/bin.dat"]);

    expect((await post(SANDBOXD_ROUTES.fsRead, "alice", { path: "missing.txt" })).status).toBe(404);
    expect((await post(SANDBOXD_ROUTES.fsRead, "alice", { path: "data" })).json.error.code).toBe("is_directory");
    expect((await post(SANDBOXD_ROUTES.fsList, "alice", { path: "data/bin.dat" })).json.error.code).toBe("not_directory");
    const ro = await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "/etc/evil", content: "" });
    expect(ro.status).toBe(403);
    expect(ro.json.error.code).toBe("permission_denied");
  });

  it("두 사용자는 서로의 workspace와 프로세스를 볼 수 없다", async () => {
    await post(SANDBOXD_ROUTES.fsWrite, "alice", { path: "secret.txt", content: Buffer.from("alice-only").toString("base64") });
    await sh("alice", "nohup sleep 300 >/dev/null 2>&1 &");
    const bob = await sh("bob", "ls -A /workspace; grep -rs alice-only / --exclude-dir=proc --exclude-dir=sys || echo NOT-FOUND; ps -eo comm");
    expect(bob.stdout).not.toContain("secret.txt");
    expect(bob.stdout).toContain("NOT-FOUND");
    // bob의 컨테이너에는 자기 프로세스뿐이다 (alice의 sleep 300이 보이지 않는다)
    const procs = bob.stdout.split("\n").filter((l) => l === "sleep");
    expect(procs).toHaveLength(0);
    // 대조군: alice 쪽에서는 보인다
    const alice = await sh("alice", "cat /workspace/secret.txt; ps -eo args | grep -c '^sleep 300'");
    expect(alice.stdout).toBe("alice-only1\n");
    // 공유 plugin 디렉토리는 둘 다 읽을 수 있지만 쓸 수 없다
    const plug = await sh("bob", "cat /opt/plugins/SKILL.md; touch /opt/plugins/x 2>&1 || true");
    expect(plug.stdout).toContain("# shared skill");
    expect(plug.stdout).toContain("Read-only file system");
  });

  it("바깥으로는 egress 프록시로만 나간다: 허용 목록의 도메인·IP만 되고, 직접 연결과 그 밖의 목적지는 안 된다", async () => {
    // 네트워크 인터페이스는 lo뿐이고 경로가 없다
    const net = await sh("alice", "ls /sys/class/net; tail -n +2 /proc/net/route | wc -l");
    expect(net.stdout).toBe("lo\n0\n");
    // curl과 Node fetch는 sandbox env(HTTP(S)_PROXY, NODE_USE_ENV_PROXY)를 따라 프록시로 나간다
    const web = await sh("alice", "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com/");
    expect(web.stdout).toBe("200");
    const node = await sh("alice", `node -e "fetch('https://example.com/').then((r) => console.log(r.status))" 2>/dev/null`);
    expect(node.stdout).toBe("200\n");
    // 프록시를 거치지 않으면 DNS도 경로도 없다 (curl 6: 이름 해석 실패, 7: 연결 실패)
    const direct = await sh(
      "alice",
      "curl -s -o /dev/null --max-time 5 --noproxy '*' https://example.com/; echo $?; curl -s -o /dev/null --max-time 5 --noproxy '*' https://1.1.1.1/; echo $?",
    );
    expect(direct.stdout).toBe("6\n7\n");
    // 프록시가 거부한다 (407): 호스트의 다른 포트(CONNECT·일반 HTTP), 사설, metadata, loopback 이름,
    // 목록에 없는 공인 IP·도메인, 허용한 도메인의 다른 포트
    const denied = await sh(
      "alice",
      [
        `curl -s -o /dev/null -p -w '%{http_connect} ' --max-time 20 https://${hostGw}:80/`,
        `curl -s -o /dev/null -w '%{http_code} ' --max-time 20 http://${hostGw}:80/`,
        "curl -s -o /dev/null -p -w '%{http_connect} ' --max-time 20 https://10.0.0.1:443/",
        "curl -s -o /dev/null -w '%{http_code} ' --max-time 20 http://169.254.169.254/latest/meta-data/",
        "curl -s -o /dev/null -w '%{http_code} ' --max-time 20 --noproxy '' -x http://127.0.0.1:3128 http://localhost:65535/",
        "curl -s -o /dev/null -p -w '%{http_connect} ' --max-time 20 https://1.1.1.1:443/",
        "curl -s -o /dev/null -p -w '%{http_connect} ' --max-time 20 https://example.org/",
        "curl -s -o /dev/null -w '%{http_code} ' --max-time 20 http://example.com/",
      ].join("; "),
    );
    expect(denied.stdout.trim().split(" ")).toEqual(["407", "407", "407", "407", "407", "407", "407", "407"]);
    // 허용 목록의 IP·포트에는 프록시가 연결을 시도한다 (아무도 듣지 않으면 502)
    const allowed = await sh("alice", `curl -s -o /dev/null -p -w '%{http_connect}' --max-time 20 https://${hostGw}:9/`);
    expect(allowed.stdout).toMatch(/^[1-9]\d\d$/);
    expect(allowed.stdout).not.toBe("407");
  }, 120_000);

  it("attach: WebSocket으로 stdio 프로세스와 주고받고, 닫으면 종료한다", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}${SANDBOXD_ROUTES.attach}`, { headers: await headers("alice") });
    await new Promise((r, j) => {
      ws.once("open", r);
      ws.once("error", j);
    });
    const messages: { text?: unknown; bin?: Buffer }[] = [];
    let wake: (() => void) | null = null;
    ws.on("message", (data, isBinary) => {
      messages.push(isBinary ? { bin: data as Buffer } : { text: JSON.parse(data.toString()) });
      wake?.();
    });
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await new Promise<void>((r) => ((wake = r), setTimeout(r, 50)));
      expect(pred()).toBe(true);
    };
    ws.send(
      JSON.stringify({
        type: "start",
        user: "alice",
        argv: ["python3", "-u", "-c", "import sys\nfor line in sys.stdin:\n    sys.stdout.write('echo:' + line)\n    sys.stdout.flush()\n    print('err', file=sys.stderr, flush=True)"],
        env: { PYTHONUNBUFFERED: "1" },
      }),
    );
    await waitFor(() => messages.some((m) => (m.text as { type?: string })?.type === "started"));
    ws.send(Buffer.from('{"jsonrpc":"2.0","id":1}\n'), { binary: true });
    await waitFor(() => Buffer.concat(messages.flatMap((m) => (m.bin ? [m.bin] : []))).toString().includes("echo:"));
    expect(Buffer.concat(messages.flatMap((m) => (m.bin ? [m.bin] : []))).toString()).toBe('echo:{"jsonrpc":"2.0","id":1}\n');
    await waitFor(() => messages.some((m) => (m.text as { type?: string })?.type === "stderr"));
    ws.close();
    let count = "";
    for (let i = 0; i < 40; i++) {
      count = (await sh("alice", "ps -eo args | grep -c '^python3 -u' || true")).stdout.trim();
      if (count === "0") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(count).toBe("0");
  });

  it("attach: 프로세스가 끝나면 exit을 보내고 닫는다", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}${SANDBOXD_ROUTES.attach}`, { headers: await headers("alice") });
    await new Promise((r) => ws.once("open", r));
    const texts: { type: string; exitCode?: number }[] = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) texts.push(JSON.parse(data.toString()));
    });
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send(JSON.stringify({ type: "start", user: "alice", argv: ["bash", "-c", "exit 5"] }));
    expect(await closed).toBe(1000);
    expect(texts.map((t) => t.type)).toEqual(["started", "exit"]);
    expect(texts[1]).toMatchObject({ exitCode: 5 });
  });

  it("관리 목록은 _admin만 볼 수 있다", async () => {
    const res = await fetch(`${base}${SANDBOXD_ROUTES.list}`, { headers: await headers(ADMIN_PRINCIPAL) });
    const body = (await res.json()) as { sandboxes: { key: string; state: string }[] };
    expect(body.sandboxes.map((s) => s.key)).toEqual(expect.arrayContaining([userKey("alice"), userKey("bob")]));
  });

  it("유휴 컨테이너를 정리하고, workspace는 남긴다", async () => {
    let now = Date.now();
    const clockManager = new SandboxManager(docker, config, new Workspaces(wsRoot), silentLogger, () => now);
    const lease = await clockManager.acquire("carol");
    lease.release();
    await clockManager.reapOnce();
    expect((await docker.getContainer(containerName(config, userKey("carol"))).inspect()).State.Running).toBe(true);
    now += config.idleSeconds * 1000 + 1;
    await clockManager.reapOnce();
    await expect(docker.getContainer(containerName(config, userKey("carol"))).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(existsSync(join(wsRoot, userKey("carol")))).toBe(true);
  });

  it("재시작한 sandboxd는 실행 중인 컨테이너를 채택하고, 멈춘 컨테이너는 지운다", async () => {
    await post(SANDBOXD_ROUTES.ensure, "dave", {});
    await post(SANDBOXD_ROUTES.ensure, "erin", {});
    await docker.getContainer(containerName(config, userKey("erin"))).stop({ t: 0 });
    const fresh = new SandboxManager(docker, config, new Workspaces(wsRoot), silentLogger);
    await fresh.reconcile();
    // 채택한 컨테이너만 마지막 사용 시각을 안다
    expect((await fresh.list()).find((s) => s.key === userKey("dave"))?.lastActiveAt).toBeDefined();
    await expect(docker.getContainer(containerName(config, userKey("erin"))).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    // 지워진 컨테이너는 다음 요청 때 다시 만든다
    const r = await sh("erin", "echo back");
    expect(r.stdout).toBe("back\n");
  });

  it("지연 시간 (참고용)", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) samples.push((await exec("alice", { argv: ["true"] })).ms);
    const fs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await post(SANDBOXD_ROUTES.fsStat, "alice", { path: "data" });
      fs.push(Date.now() - t0);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.info(`exec median ${median(samples)}ms, fs/stat median ${median(fs)}ms`);
    expect(median(samples)).toBeLessThan(1000);
  });
});
