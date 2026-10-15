#!/usr/bin/env bash
# 실행 중인 compose 서비스 안에서 비밀 파일(/run/secrets/*)의 소유자·권한을 확인하고,
# mcp-broker의 stdio 하위 프로세스 uid로 실제로 읽어 본다 (읽히면 실패).
#
#   ./scripts/security-check/check-secret-files.sh                 # 저장소 위치에서 기본 compose 프로젝트
#   ./scripts/security-check/check-secret-files.sh -p myproj --env-file /path/.env
#
# 인자는 그대로 `docker compose`에 넘긴다. 종료 코드: 0 = 모두 통과, 1 = 실패 있음.
# 기대값: gateway 10001:0400, sandboxd 1000:0400, mcp-broker 0:0400,
#         broker 하위 프로세스 uid(BROKER_STDIO_UID_RANGE의 첫 값, 기본 20000)는 /run/secrets/*와 /data를 읽지 못한다.
set -uo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose "$@")
STDIO_UID="${STDIO_UID:-20000}"
fail=0

pass() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=1; }

check_service() {
  local svc="$1" want_uid="$2" out owner mode name
  if ! out="$("${COMPOSE[@]}" exec -T "$svc" sh -c 'for f in /run/secrets/*; do [ -e "$f" ] && stat -c "%u %a %n" "$f"; done' 2>&1)"; then
    bad "$svc: exec failed: $out"
    return
  fi
  if [ -z "$out" ]; then
    bad "$svc: no files in /run/secrets"
    return
  fi
  while read -r owner mode name; do
    if [ "$owner" = "$want_uid" ] && [ "$mode" = "400" ]; then
      pass "$svc $name owner=$owner mode=$mode"
    else
      bad "$svc $name owner=$owner mode=$mode (want owner=$want_uid mode=400)"
    fi
  done <<< "$out"
}

check_service gateway 10001
check_service sandboxd 1000
check_service mcp-broker 0

# broker의 stdio MCP 서버가 쓰는 uid로 읽기 시도
out="$("${COMPOSE[@]}" exec -T mcp-broker setpriv --reuid "$STDIO_UID" --regid "$STDIO_UID" --clear-groups sh -c '
  for f in /run/secrets/*; do
    if cat "$f" >/dev/null 2>&1; then echo "READABLE $f"; else echo "DENIED $f"; fi
  done
  if ls /data >/dev/null 2>&1; then echo "READABLE /data"; else echo "DENIED /data"; fi
  if cat /proc/1/environ >/dev/null 2>&1; then echo "READABLE /proc/1/environ"; else echo "DENIED /proc/1/environ"; fi
' 2>&1)"
if [ -z "$out" ]; then
  bad "mcp-broker: could not run as uid $STDIO_UID"
fi
while read -r state path; do
  [ -z "$state" ] && continue
  if [ "$state" = "DENIED" ]; then
    pass "mcp-broker uid $STDIO_UID cannot read $path"
  else
    bad "mcp-broker uid $STDIO_UID can read $path"
  fi
done <<< "$out"

# 실행 중인 sandbox 컨테이너에는 비밀 파일이 없어야 한다
for c in $(docker ps -q --filter label=pi-gateway.sandbox=1); do
  name="$(docker inspect -f '{{.Name}}' "$c")"
  if docker exec "$c" sh -c '[ -e /run/secrets ] && ls -A /run/secrets' 2>/dev/null | grep -q .; then
    bad "sandbox $name has /run/secrets"
  else
    pass "sandbox $name has no /run/secrets"
  fi
done

exit "$fail"
