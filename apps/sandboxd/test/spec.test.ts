import { userKey } from "@pi-gateway/shared";
import { describe, expect, it } from "vitest";
import { loadConfig, parseBytes } from "../src/config.js";
import { decodeExit, Demuxer } from "../src/docker-exec.js";
import { buildContainerSpec, LABEL_ANON, LABEL_INSTANCE, LABEL_SANDBOX, LABEL_SPEC, LABEL_USER_KEY } from "../src/spec.js";
import { SECRET_TEXT, testConfig } from "./helpers.js";

describe("buildContainerSpec — 보안 옵션은 코드에 고정된다", () => {
  const key = userKey("alice");
  const spec = buildContainerSpec(testConfig(), { key, anon: false });
  const host = spec.HostConfig!;

  it("rootfs 읽기 전용, 권한 전부 제거, 권한 상승 금지, init", () => {
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd).toEqual([]);
    expect(host.Privileged).toBe(false);
    expect(host.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(host.Init).toBe(true);
  });

  it("root가 아닌 uid 1000, hostname sandbox, workdir /workspace", () => {
    expect(spec.User).toBe("1000:1000");
    expect(spec.Hostname).toBe("sandbox");
    expect(spec.WorkingDir).toBe("/workspace");
  });

  it("mount는 정확히 세 개: 본인 workspace(rw), egress 프록시 socket 볼륨(ro), plugins(ro)", () => {
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([
      {
        Type: "bind",
        Source: `/host/workspaces/${key}`,
        Target: "/workspace",
        ReadOnly: false,
        BindOptions: { Propagation: "rprivate" },
      },
      { Type: "volume", Source: "pi-gw-test-proxy-sock", Target: "/run/pi-proxy", ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: "bind", Source: "/host/plugins", Target: "/opt/plugins", ReadOnly: true, BindOptions: { Propagation: "rprivate" } },
    ]);
    expect(JSON.stringify(spec)).not.toContain("docker.sock");
    expect(host.Devices).toEqual([]);
  });

  it("plugins 경로가 없으면 workspace와 프록시 socket만 mount한다", () => {
    const s = buildContainerSpec(testConfig({ pluginsHostDir: undefined }), { key, anon: false });
    expect(s.HostConfig!.Mounts!.map((m) => m.Target)).toEqual(["/workspace", "/run/pi-proxy"]);
  });

  it("자원 제한과 /tmp tmpfs", () => {
    expect(host.Memory).toBe(512 * 1024 * 1024);
    expect(host.MemorySwap).toBe(host.Memory);
    expect(host.NanoCpus).toBe(1_000_000_000);
    expect(host.PidsLimit).toBe(128);
    expect(host.Tmpfs).toEqual({ "/tmp": "rw,exec,nosuid,nodev,size=64m,mode=1777" });
    expect(host.IpcMode).toBe("private");
    expect(host.PidMode).toBe("");
    expect(host.UsernsMode).toBe("");
  });

  it("네트워크가 없고(none), 재시작하지 않고, 로그를 남기지 않는다", () => {
    expect(host.NetworkMode).toBe("none");
    expect(host.Dns).toBeUndefined();
    expect(host.RestartPolicy).toEqual({ Name: "no" });
    expect(host.LogConfig?.Type).toBe("none");
    expect(host.ExtraHosts).toEqual([]);
  });

  it("label로 정리 범위를 구분한다", () => {
    expect(spec.Labels).toEqual({
      [LABEL_SANDBOX]: "1",
      [LABEL_USER_KEY]: key,
      [LABEL_ANON]: "0",
      [LABEL_INSTANCE]: "unit",
      [LABEL_SPEC]: "2",
    });
    expect(spec.name).toBe(`pi-sbx-test-${key}`);
  });

  it("메인 프로세스는 프록시 연결기이고, 프록시 env로 바깥에 나간다", () => {
    expect(spec.Cmd).toEqual(["/usr/local/bin/sbx-proxy-bridge"]);
    expect(spec.Env).toEqual([
      "HOME=/workspace/.home",
      "HTTP_PROXY=http://127.0.0.1:3128",
      "HTTPS_PROXY=http://127.0.0.1:3128",
      "http_proxy=http://127.0.0.1:3128",
      "https_proxy=http://127.0.0.1:3128",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "no_proxy=localhost,127.0.0.1,::1",
      "NODE_USE_ENV_PROXY=1",
    ]);
  });

  it("gVisor 같은 runtime을 설정할 수 있다", () => {
    const s = buildContainerSpec(testConfig({ runtime: "runsc" }), { key, anon: true });
    expect(s.HostConfig!.Runtime).toBe("runsc");
    expect(s.Labels![LABEL_ANON]).toBe("1");
    expect(host.Runtime).toBeUndefined();
  });

  it("이상한 key는 거부한다", () => {
    expect(() => buildContainerSpec(testConfig(), { key: "../etc", anon: false })).toThrow();
    expect(() => buildContainerSpec(testConfig(), { key: "u-XYZ", anon: false })).toThrow();
  });
});

describe("config", () => {
  it("크기 표기를 바이트로 바꾼다", () => {
    expect(parseBytes("x", "512m")).toBe(512 * 1024 ** 2);
    expect(parseBytes("x", "1g")).toBe(1024 ** 3);
    expect(parseBytes("x", "1GiB")).toBe(1024 ** 3);
    expect(parseBytes("x", "2048")).toBe(2048);
    expect(() => parseBytes("x", "lots")).toThrow();
  });

  it("비밀키와 절대 경로를 요구한다", () => {
    expect(() => loadConfig({ WORKSPACES_DIR: "/w" })).toThrow(/SANDBOXD_JWT_SECRET/);
    expect(() => loadConfig({ SANDBOXD_JWT_SECRET: SECRET_TEXT, WORKSPACES_DIR: "rel" })).toThrow(/absolute/);
    const c = loadConfig({ SANDBOXD_JWT_SECRET: SECRET_TEXT, WORKSPACES_DIR: "/w/", SANDBOX_IDLE_SECONDS: "60" });
    expect(c.workspacesDir).toBe("/w");
    expect(c.workspacesHostDir).toBe("/w");
    expect(c.pluginsHostDir).toBeUndefined();
    expect(c.reapIntervalMs).toBe(15_000);
  });

  it("egress 프록시 socket 볼륨 이름", () => {
    const env = { SANDBOXD_JWT_SECRET: SECRET_TEXT, WORKSPACES_DIR: "/w" };
    expect(loadConfig(env).proxyVolume).toBe("pi-gateway-proxy-sock");
    expect(loadConfig({ ...env, SANDBOX_PROXY_VOLUME: "other_proxy-sock" }).proxyVolume).toBe("other_proxy-sock");
    expect(() => loadConfig({ ...env, SANDBOX_PROXY_VOLUME: "../x" })).toThrow(/SANDBOX_PROXY_VOLUME/);
  });

  it("짧은 비밀키는 거부한다", () => {
    expect(() => loadConfig({ SANDBOXD_JWT_SECRET: "short", WORKSPACES_DIR: "/w" })).toThrow(/32 bytes/);
  });
});

describe("Demuxer", () => {
  const frame = (type: number, text: string) => {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = type;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  };

  it("chunk 경계와 상관없이 프레임을 나눈다", () => {
    const got: string[] = [];
    const d = new Demuxer((s, c) => got.push(`${s}:${c.toString()}`));
    const all = Buffer.concat([frame(1, "hello"), frame(2, "oops"), frame(1, "world")]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    expect(got).toEqual(["stdout:hello", "stderr:oops", "stdout:world"]);
  });

  it("한 chunk에 여러 프레임이 와도 처리하고, 빈 프레임은 건너뛴다", () => {
    const got: string[] = [];
    const d = new Demuxer((s, c) => got.push(`${s}:${c.toString()}`));
    d.push(Buffer.concat([frame(1, "a"), frame(1, ""), frame(2, "b")]));
    expect(got).toEqual(["stdout:a", "stderr:b"]);
  });
});

describe("decodeExit", () => {
  it("우리가 신호를 보낸 경우에만 128+N을 신호로 본다", () => {
    expect(decodeExit(143, true)).toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(decodeExit(137, true)).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(decodeExit(143, false)).toEqual({ exitCode: 143, signal: null });
    expect(decodeExit(0, true)).toEqual({ exitCode: 0, signal: null });
    expect(decodeExit(null, true)).toEqual({ exitCode: null, signal: null });
  });
});
