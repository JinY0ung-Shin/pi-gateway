# syntax=docker/dockerfile:1
# pi-gateway Node 서비스 이미지 (multi-stage). target으로 서비스를 고른다:
#   docker build --target gateway    -t pi-gateway/gateway .
#   docker build --target sandboxd   -t pi-gateway/sandboxd .
#   docker build --target mcp-broker -t pi-gateway/mcp-broker .
#   docker build --target egress-proxy -t pi-gateway/egress-proxy .
# sandbox 이미지는 images/sandbox/Dockerfile 로 따로 만든다. 보통은 docker compose build로 한 번에 빌드한다.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG GO_IMAGE=golang:1.25-alpine

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
# 사내 미러 (.env의 APT_MIRROR_URL·APT_SECURITY_MIRROR_URL·NPM_CONFIG_REGISTRY). 비우면 공식 저장소를 쓴다.
# 모든 Node 단계가 이 단계에서 시작하므로 여기서 한 번 바꾸면 된다.
ARG APT_MIRROR_URL=""
ARG APT_SECURITY_MIRROR_URL=""
ARG NPM_CONFIG_REGISTRY=""
RUN sources=/etc/apt/sources.list.d/debian.sources \
 && security="${APT_SECURITY_MIRROR_URL:-$APT_MIRROR_URL}" \
 && if [ -n "$APT_MIRROR_URL" ]; then sed -i "s|^URIs: http://deb.debian.org/debian\$|URIs: $APT_MIRROR_URL|" "$sources"; fi \
 && if [ -n "$security" ]; then sed -i "s|^URIs: http://deb.debian.org/debian-security\$|URIs: $security|" "$sources"; fi \
 && if [ -n "$NPM_CONFIG_REGISTRY" ]; then npm config set --global registry "$NPM_CONFIG_REGISTRY"; fi

# 의존성 계산에 필요한 파일만 먼저 복사한다 (소스가 바뀌어도 npm ci 캐시를 쓴다)
FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/sandboxd/package.json apps/sandboxd/
COPY apps/mcp-broker/package.json apps/mcp-broker/
COPY apps/admin-ui/package.json apps/admin-ui/

# ── 빌드 ────────────────────────────────────────────────────────────
# install script는 돌리지 않는다 (better-sqlite3는 prebuild를, esbuild는 플랫폼 패키지를 쓴다).
# 서비스마다 따로 빌드해서, 한 서비스의 빌드 실패가 다른 이미지에 영향을 주지 않게 한다.
FROM manifests AS build-deps
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps

FROM build-deps AS build-sandboxd
RUN npx tsc -b apps/sandboxd

FROM build-deps AS build-broker
RUN npx tsc -b apps/mcp-broker

FROM build-deps AS build-gateway
RUN npx tsc -b apps/gateway \
 && npm run build -w @pi-gateway/admin-ui \
 && test -f apps/gateway/public/admin/index.html

# ── 서비스별 운영 의존성 ────────────────────────────────────────────
FROM manifests AS deps-gateway
RUN npm ci --omit=dev --ignore-scripts --workspace @pi-gateway/gateway

FROM manifests AS deps-sandboxd
RUN npm ci --omit=dev --ignore-scripts --workspace @pi-gateway/sandboxd

FROM manifests AS deps-broker
RUN npm ci --omit=dev --ignore-scripts --workspace @pi-gateway/mcp-broker

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json ./
COPY packages/shared/package.json packages/shared/

# ── gateway ─────────────────────────────────────────────────────────
# git: plugin marketplace 설치에 쓴다. LLM 키·세션 기록을 갖고 있으므로 사용자 코드를 실행하지 않는다.
FROM runtime AS gateway
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && groupadd -g 10001 gateway \
 && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin gateway \
 && mkdir -p /data /opt/plugins \
 && chown 10001:10001 /data /opt/plugins \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --from=deps-gateway /app/node_modules node_modules
COPY --from=build-gateway /app/packages/shared/dist packages/shared/dist
COPY --from=build-gateway /app/apps/gateway/package.json apps/gateway/
COPY --from=build-gateway /app/apps/gateway/dist apps/gateway/dist
COPY --from=build-gateway /app/apps/gateway/public apps/gateway/public
ENV DATA_DIR=/data PLUGINS_DIR=/opt/plugins PI_OFFLINE=1 HOME=/tmp
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/main.js"]

# ── sandboxd ────────────────────────────────────────────────────────
# docker.sock을 가진 유일한 서비스. uid 1000(node)으로 돌고 compose에서 docker 그룹을 붙인다.
# workspace 디렉토리를 sandbox와 같은 uid 1000 소유로 만든다.
FROM runtime AS sandboxd
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --from=deps-sandboxd /app/node_modules node_modules
COPY --from=build-sandboxd /app/packages/shared/dist packages/shared/dist
COPY --from=build-sandboxd /app/apps/sandboxd/package.json apps/sandboxd/
COPY --from=build-sandboxd /app/apps/sandboxd/dist apps/sandboxd/dist
ENV HOME=/tmp
USER 1000:1000
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7070)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/sandboxd/dist/main.js"]

# ── mcp-broker ──────────────────────────────────────────────────────
# MCP 비밀키를 가진 서비스. 원격 MCP 서버(streamable HTTP)에 비밀키를 붙여 프록시한다.
FROM runtime AS mcp-broker
RUN mkdir -p /data \
 && chmod 0700 /data \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
COPY --from=deps-broker /app/node_modules node_modules
COPY --from=build-broker /app/packages/shared/dist packages/shared/dist
COPY --from=build-broker /app/apps/mcp-broker/package.json apps/mcp-broker/
COPY --from=build-broker /app/apps/mcp-broker/dist apps/mcp-broker/dist
ENV DATA_DIR=/data HOME=/tmp
EXPOSE 7080 7081
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BROKER_PORT||7080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/mcp-broker/dist/main.js"]

# ── egress-proxy ────────────────────────────────────────────────────
# sandbox의 유일한 바깥 출구. Stripe Smokescreen v0.1.0(go.mod/go.sum으로 고정)을 감싼 정적 바이너리.
# unix socket(/run/pi-proxy/proxy.sock)에서만 듣고, 비밀값이 없다.
FROM ${GO_IMAGE} AS egress-proxy-build
WORKDIR /src
# 사내 Go module 미러 (.env). 비우면 proxy.golang.org
ARG GOPROXY=""
COPY images/egress-proxy/go.mod images/egress-proxy/go.sum ./
RUN go mod download && go mod verify
COPY images/egress-proxy/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/egress-proxy . \
 && mkdir -p /out/run/pi-proxy

FROM scratch AS egress-proxy
COPY --from=egress-proxy-build /out/egress-proxy /egress-proxy
# 볼륨이 처음 mount될 때 이 디렉토리의 소유자(65532)가 볼륨으로 복사된다
COPY --from=egress-proxy-build --chown=65532:65532 /out/run/pi-proxy /run/pi-proxy
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD ["/egress-proxy", "healthcheck"]
ENTRYPOINT ["/egress-proxy"]
