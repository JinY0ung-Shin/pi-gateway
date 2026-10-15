import type Docker from "dockerode";
import type { Logger } from "pino";
import type { SandboxdConfig } from "./config.js";
import { dockerStatus } from "./errors.js";
import { LABEL_INSTANCE } from "./spec.js";

/**
 * egress 프록시 socket 볼륨을 확인한다. 없으면 만든다 (보통은 compose가 먼저 만든다).
 * egress-proxy 컨테이너가 여기에 socket을 만들고, sandbox는 network_mode none으로 이 볼륨만 읽기 전용으로 mount한다.
 * 프록시가 없으면 sandbox는 그대로 동작하지만 바깥으로 나가지 못한다.
 */
export async function ensureProxyVolume(docker: Docker, config: SandboxdConfig, log: Logger): Promise<void> {
  try {
    await docker.getVolume(config.proxyVolume).inspect();
    return;
  } catch (err) {
    if (dockerStatus(err) !== 404) throw err;
  }
  await docker.createVolume({
    Name: config.proxyVolume,
    Labels: { "pi-gateway.proxy-socket": "1", [LABEL_INSTANCE]: config.instance },
  });
  log.warn(
    { volume: config.proxyVolume },
    "created egress proxy socket volume; sandboxes have no outbound access until egress-proxy serves this volume",
  );
}

/** sandbox 이미지가 있는지 확인한다. 없으면 경고만 한다 (compose가 따로 빌드한다). */
export async function checkSandboxImage(docker: Docker, config: SandboxdConfig, log: Logger): Promise<boolean> {
  try {
    await docker.getImage(config.image).inspect();
    return true;
  } catch (err) {
    if (dockerStatus(err) !== 404) throw err;
    log.error({ image: config.image }, "sandbox image not found; build it with `docker compose build sandbox-image`");
    return false;
  }
}
