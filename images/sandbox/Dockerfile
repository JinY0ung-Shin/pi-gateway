# syntax=docker/dockerfile:1
# pi-gateway sandbox 이미지 — agent의 도구(bash, 파일 조작, sandbox 실행 MCP 서버)가 도는 환경.
# 비밀값을 넣지 않는다. sandboxd가 read-only rootfs, cap-drop ALL, no-new-privileges, uid 1000,
# network_mode none으로 실행한다. 바깥으로는 sbx-proxy-bridge → egress 프록시로만 나간다.
#
#   docker build -t pi-gateway/sandbox:latest images/sandbox
#
# 도구를 더하려면 이 이미지를 FROM으로 쓰는 파생 이미지를 만든다 (docs/OPERATIONS.md "sandbox에 도구 추가하기").

ARG PYTHON_IMAGE=python:3.12-slim-trixie
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${PYTHON_IMAGE} AS helpers
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sbx-run.c sbx-proxy-bridge.c /src/
RUN mkdir -p /out \
 && gcc -O2 -static -Wall -Wextra -Werror -o /out/sbx-run /src/sbx-run.c \
 && gcc -O2 -static -Wall -Wextra -Werror -o /out/sbx-proxy-bridge /src/sbx-proxy-bridge.c

FROM ${PYTHON_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git jq ripgrep fd-find procps less file \
      zip unzip xz-utils libstdc++6 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

# Node 22 (공식 바이너리) + npm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

COPY --from=helpers /out/sbx-run /out/sbx-proxy-bridge /usr/local/bin/
COPY sbx_fs.py /usr/local/lib/pi-sbx/sbx_fs.py

# 최소한의 /etc, setuid/setgid 제거, 표준 라이브러리 미리 컴파일, 도우미는 root 소유·쓰기 불가
RUN printf '#!/usr/local/bin/python3 -IS\nimport sys\nsys.path.insert(0, "/usr/local/lib/pi-sbx")\nimport sbx_fs\nsbx_fs.main_entry()\n' > /usr/local/bin/sbx-fs \
 && chown -R root:root /usr/local/bin/sbx-run /usr/local/bin/sbx-proxy-bridge /usr/local/bin/sbx-fs /usr/local/lib/pi-sbx \
 && chmod 0755 /usr/local/bin/sbx-run /usr/local/bin/sbx-proxy-bridge /usr/local/bin/sbx-fs \
 && python3 -m compileall -q -j 0 -x '/(test|tests|idlelib|tkinter|turtledemo|lib2to3)/' \
      /usr/local/lib/python3.12 /usr/local/lib/pi-sbx >/dev/null \
 && printf 'root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:1000:1000:agent:/workspace/.home:/bin/bash\n' > /etc/passwd \
 && printf 'root:x:0:\nagent:x:1000:\n' > /etc/group \
 && rm -f /etc/shadow /etc/gshadow /etc/shadow- /etc/gshadow- /etc/passwd- /etc/group- /etc/subuid /etc/subgid \
 && echo sandbox > /etc/hostname \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && rm -rf /root/.cache /root/.npm /tmp/* /var/tmp/*

# PATH는 시스템 경로가 먼저다. workspace에 node·timeout 같은 이름의 파일을 심어도 시스템 명령을 가리지 못한다.
ENV HOME=/workspace/.home \
    PATH=/usr/local/bin:/usr/bin:/bin:/workspace/.home/.local/bin:/workspace/.home/.npm-global/bin \
    PYTHONUSERBASE=/workspace/.home/.local \
    PIP_CACHE_DIR=/workspace/.home/.cache/pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NPM_CONFIG_PREFIX=/workspace/.home/.npm-global \
    NPM_CONFIG_CACHE=/workspace/.home/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_PATH=/usr/local/lib/node_modules \
    TMPDIR=/tmp \
    LANG=C.UTF-8

USER 1000:1000
WORKDIR /workspace
# 네트워크가 없는 sandbox의 유일한 출구: 127.0.0.1:3128 → egress 프록시 unix socket.
# HTTP(S)_PROXY는 sandboxd가 컨테이너 env로 넣는다 (이미지에 넣으면 파생 이미지의 docker build가 깨진다).
CMD ["/usr/local/bin/sbx-proxy-bridge"]
