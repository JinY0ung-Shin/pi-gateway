import type Docker from "dockerode";
import { SANDBOX_GID, SANDBOX_HOME, SANDBOX_PLUGINS_DIR, SANDBOX_UID, SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { SandboxdConfig } from "./config.js";

export const LABEL_SANDBOX = "pi-gateway.sandbox";
export const LABEL_USER_KEY = "pi-gateway.user-key";
export const LABEL_INSTANCE = "pi-gateway.instance";
/** 컨테이너 스펙 버전. 보안 옵션 등 스펙을 바꾸면 올린다. 다른 버전의 컨테이너는 실행 중이어도 다시 만든다. */
export const LABEL_SPEC = "pi-gateway.spec";
export const SPEC_VERSION = "2";

/** sandbox 안에서 egress 프록시로 가는 유일한 출구 (sbx-proxy-bridge) */
export const PROXY_SOCKET_DIR = "/run/pi-proxy";
export const PROXY_URL = "http://127.0.0.1:3128";
const NO_PROXY = "localhost,127.0.0.1,::1";

export const USER_KEY_PATTERN = /^u-[0-9a-f]{24}$/;

export function containerName(config: Pick<SandboxdConfig, "containerPrefix">, key: string): string {
  return `${config.containerPrefix}${key}`;
}

/**
 * sandbox 컨테이너 스펙. 보안 옵션은 전부 여기서 고정한다 (호출자가 바꿀 수 없다). test/spec.test.ts가 확인한다.
 * sandbox는 network_mode none이고, 바깥으로는 egress 프록시(unix socket)로만 나간다.
 */
export function buildContainerSpec(config: SandboxdConfig, key: string): Docker.ContainerCreateOptions {
  if (!USER_KEY_PATTERN.test(key)) throw new Error(`invalid user key: ${key}`);
  const mounts: Docker.MountSettings[] = [
    {
      Type: "bind",
      Source: `${config.workspacesHostDir}/${key}`,
      Target: SANDBOX_WORKSPACE,
      ReadOnly: false,
      BindOptions: { Propagation: "rprivate" },
    },
  ];
  // egress 프록시 socket (읽기 전용). sandbox 안의 sbx-proxy-bridge가 127.0.0.1:3128을 여기로 잇는다.
  mounts.push({
    Type: "volume",
    Source: config.proxyVolume,
    Target: PROXY_SOCKET_DIR,
    ReadOnly: true,
    // @types/dockerode는 VolumeOptions의 모든 필드를 필수로 적어 두었지만 Docker API에서는 전부 선택이다
    VolumeOptions: { NoCopy: true } as Docker.MountSettings["VolumeOptions"],
  });
  if (config.pluginsHostDir) {
    mounts.push({
      Type: "bind",
      Source: config.pluginsHostDir,
      Target: SANDBOX_PLUGINS_DIR,
      ReadOnly: true,
      BindOptions: { Propagation: "rprivate" },
    });
  }

  const hostConfig: Docker.HostConfig = {
    Init: true,
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ["ALL"],
    CapAdd: [],
    SecurityOpt: ["no-new-privileges:true"],
    // Docker는 tmpfs에 noexec를 기본으로 붙인다. pip 빌드 격리 등이 /tmp에서 실행하므로 exec를 명시한다
    // (/workspace도 실행 가능하므로 /tmp의 noexec는 보안상 의미가 없다).
    Tmpfs: { "/tmp": `rw,exec,nosuid,nodev,size=${config.tmpSize},mode=1777` },
    Mounts: mounts,
    Binds: [],
    Memory: config.memoryBytes,
    MemorySwap: config.memoryBytes,
    NanoCpus: config.nanoCpus,
    PidsLimit: config.pidsLimit,
    ShmSize: config.shmSizeBytes,
    IpcMode: "private",
    PidMode: "",
    UsernsMode: "",
    // 네트워크 없음: 경로·DNS·호스트·다른 sandbox로 가는 길이 없다. 바깥은 egress 프록시로만 나간다.
    NetworkMode: "none",
    RestartPolicy: { Name: "no" },
    AutoRemove: false,
    LogConfig: { Type: "none", Config: {} },
    OomScoreAdj: 500,
    Devices: [],
    ExtraHosts: [],
  };
  if (config.runtime) hostConfig.Runtime = config.runtime;

  return {
    name: containerName(config, key),
    Image: config.image,
    Cmd: ["/usr/local/bin/sbx-proxy-bridge"],
    User: `${SANDBOX_UID}:${SANDBOX_GID}`,
    WorkingDir: SANDBOX_WORKSPACE,
    Hostname: "sandbox",
    Env: [
      `HOME=${SANDBOX_HOME}`,
      `HTTP_PROXY=${PROXY_URL}`,
      `HTTPS_PROXY=${PROXY_URL}`,
      `http_proxy=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
      `NO_PROXY=${NO_PROXY}`,
      `no_proxy=${NO_PROXY}`,
      // Node의 전역 fetch는 이 값이 있어야 프록시 env를 따른다 (monsemi-frontend MCP 서버가 fetch를 쓴다)
      "NODE_USE_ENV_PROXY=1",
    ],
    Labels: {
      [LABEL_SANDBOX]: "1",
      [LABEL_USER_KEY]: key,
      [LABEL_INSTANCE]: config.instance,
      [LABEL_SPEC]: SPEC_VERSION,
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    NetworkDisabled: false,
    HostConfig: hostConfig,
  };
}
