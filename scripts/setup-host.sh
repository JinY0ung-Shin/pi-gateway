#!/usr/bin/env bash
# pi-gateway 호스트 준비: 데이터 디렉토리와 비밀값 파일을 만든다. 이미 있는 것은 건드리지 않는다.
#
#   sudo PI_GATEWAY_HOME=/srv/pi-gateway ./scripts/setup-host.sh
#
# 만드는 것
#   $PI_GATEWAY_HOME/workspaces   uid 1000 (sandbox 사용자), 0700 — 사용자별 workspace
#   $PI_GATEWAY_HOME/plugins      uid 10001 (gateway), 0755      — 설치된 plugin (sandbox는 읽기만)
#   $PI_GATEWAY_SECRETS/{gateway,sandboxd,broker}/*  쓰는 서비스의 uid 소유 0400 — compose secrets
#   .env의 DOCKER_GID, PI_GATEWAY_HOME, PI_GATEWAY_SECRETS (없을 때만 추가)
set -euo pipefail

: "${PI_GATEWAY_HOME:?set PI_GATEWAY_HOME to an absolute path, e.g. /srv/pi-gateway}"
case "$PI_GATEWAY_HOME" in /*) ;; *) echo "PI_GATEWAY_HOME must be absolute" >&2; exit 1 ;; esac
SECRETS="${PI_GATEWAY_SECRETS:-$PI_GATEWAY_HOME/secrets}"
case "$SECRETS" in /*) ;; *) echo "PI_GATEWAY_SECRETS must be absolute" >&2; exit 1 ;; esac
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
DOCKER_SOCK=/var/run/docker.sock

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (directory ownership needs chown)" >&2
  exit 1
fi

install -d -m 0755 "$PI_GATEWAY_HOME"
install -d -o 1000 -g 1000 -m 0700 "$PI_GATEWAY_HOME/workspaces"
install -d -o 10001 -g 10001 -m 0755 "$PI_GATEWAY_HOME/plugins"
install -d -o 0 -g 0 -m 0700 "$SECRETS"

# 비밀값 파일: 쓰는 서비스마다 사본을 두고, 그 서비스의 uid 소유 0400으로 만든다.
#   gateway  (uid 10001): $SECRETS/gateway/*
#   sandboxd (uid 1000) : $SECRETS/sandboxd/*
#   broker   (root)     : $SECRETS/broker/*
# 두 서비스가 같이 쓰는 값(sandboxd_jwt_secret, broker_jwt_secret)은 같은 값의 사본이다.
GW_UID=10001; SBX_UID=1000
install -d -o 0 -g 0 -m 0700 "$SECRETS/gateway" "$SECRETS/sandboxd" "$SECRETS/broker"

rand() { openssl rand -base64 "$1" | tr -d '\n'; }

# put <value> <path> <uid>: 0400, uid 소유로 쓴다
put() {
  local value="$1" path="$2" owner="$3" tmp
  tmp="$(mktemp "$SECRETS/.tmp.XXXXXX")"
  printf '%s' "$value" > "$tmp"
  install -o "$owner" -g "$owner" -m 0400 "$tmp" "$path"
  rm -f "$tmp"
}

# secret <name> <generator-cmd> <dest:uid>... — 이미 있는 사본의 값을 쓰고, 없으면 새로 만든다.
# 사본끼리 값이 다르면 멈춘다.
secret() {
  local name="$1" gen="$2"
  shift 2
  local value="" dest path owner current
  for dest in "$@"; do
    path="${dest%%:*}"
    if [ -f "$path" ]; then
      current="$(cat "$path")"
      if [ -n "$value" ] && [ "$current" != "$value" ]; then
        echo "error: copies of $name differ ($path) — fix them by hand" >&2
        exit 1
      fi
      value="$current"
    fi
  done
  if [ -z "$value" ] && [ "$gen" != "empty" ]; then value="$($gen)"; fi
  for dest in "$@"; do
    path="${dest%%:*}"; owner="${dest##*:}"
    if [ -f "$path" ]; then
      chown "$owner:$owner" "$path"; chmod 0400 "$path"
      echo "keep   $path"
    else
      put "$value" "$path" "$owner"
      echo "create $path"
    fi
  done
}
gen48() { rand 48; }
gen32() { rand 32; }
kek() { openssl rand -base64 32 | tr -d '\n'; }

G="$SECRETS/gateway"; X="$SECRETS/sandboxd"; B="$SECRETS/broker"
secret sandboxd_jwt_secret gen48 "$G/sandboxd_jwt_secret:$GW_UID" "$X/sandboxd_jwt_secret:$SBX_UID"
secret broker_jwt_secret   gen48 "$G/broker_jwt_secret:$GW_UID"   "$B/broker_jwt_secret:0"
secret broker_kek          kek   "$B/broker_kek:0"
secret admin_api_key       gen32 "$G/admin_api_key:$GW_UID"
secret api_key             gen32 "$G/api_key:$GW_UID"
# 사용자별 키는 운영자가 채운다: {"alice": "<32자 이상 키>"} (빈 파일 = 쓰지 않음)
secret user_api_keys       empty "$G/user_api_keys:$GW_UID"

if [ -S "$DOCKER_SOCK" ]; then
  gid="$(stat -c %g "$DOCKER_SOCK")"
else
  echo "warning: $DOCKER_SOCK not found; set DOCKER_GID manually" >&2
  gid=""
fi

touch "$ENV_FILE"
add_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    echo "keep   $key in $ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "add    $key=$value to $ENV_FILE"
  fi
}
add_env PI_GATEWAY_HOME "$PI_GATEWAY_HOME"
add_env PI_GATEWAY_SECRETS "$SECRETS"
[ -n "$gid" ] && add_env DOCKER_GID "$gid"

echo
echo "next:"
echo "  1. edit $ENV_FILE if needed — see .env.example"
echo "  2. fill $SECRETS/gateway/user_api_keys if needed (keep 0400, owner 10001)"
echo "  3. docker compose up -d --build"
echo "  4. log in to /admin (key: $SECRETS/gateway/admin_api_key) and set the LLM on the LLM page"
echo "  5. ./scripts/security-check/check-secret-files.sh  (permissions inside the running containers)"
