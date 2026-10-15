#!/usr/bin/env bash
# 유휴 sandbox 컨테이너 한 개가 쓰는 메모리와 docker exec 지연을 이 Docker 호스트에서 잰다.
# 운영 서버에서 그대로 돌려서 용량을 정한다 (개발 머신 수치로 운영 용량을 정하지 않는다).
#
#   ./scripts/bench/container-overhead.sh [이미지] [컨테이너 수]
#   예: ./scripts/bench/container-overhead.sh pi-gateway/sandbox:latest 10
#
# 출력: 컨테이너별 cgroup 메모리(docker stats), containerd-shim RSS, containerd/dockerd 증가분,
#       docker exec 평균 지연, 생성·재시작 지연. 만든 컨테이너는 끝에 지운다.
set -u
IMG="${1:-pi-gateway/sandbox:latest}"
N="${2:-5}"
LABEL="pi-gw-bench=$$"
SECURITY=(--init --read-only --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --security-opt no-new-privileges
  --user 1000:1000 --memory 1g --pids-limit 256 --network none)

cleanup() { docker rm -f $(docker ps -aq --filter "label=$LABEL") >/dev/null 2>&1 || true; }
trap cleanup EXIT

shims() { ps -eo pid=,rss=,comm= | awk '$3 ~ /^containerd-shim/ {print $1" "$2}' | sort; }
rss_of() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' '; }

before=$(shims)
dpid=$(pgrep -x dockerd | head -1); cpid=$(pgrep -x containerd | head -1)
d0=$(rss_of "$dpid"); c0=$(rss_of "$cpid")

for i in $(seq 1 "$N"); do
  docker run -d --label "$LABEL" "${SECURITY[@]}" "$IMG" sleep infinity >/dev/null
done
sleep 3

echo "== 이미지 $IMG, 컨테이너 $N개 =="
echo "-- 컨테이너 안 프로세스의 메모리 (cgroup, docker stats)"
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(docker ps -q --filter "label=$LABEL")

echo "-- 새로 생긴 containerd-shim RSS (KB, 공유 페이지 포함이라 실제 증가분보다 크게 나온다)"
new=$(comm -13 <(echo "$before" | awk '{print $1}') <(shims | awk '{print $1}'))
total=0
for pid in $new; do r=$(rss_of "$pid"); [ -n "$r" ] && { echo "shim $pid $r"; total=$((total + r)); }; done
[ -n "$new" ] && echo "shim 평균 $((total / $(echo "$new" | wc -w))) KB"

d1=$(rss_of "$dpid"); c1=$(rss_of "$cpid")
echo "-- daemon RSS 증가 (KB, 컨테이너 $N개): dockerd $((d1 - d0)), containerd $((c1 - c0))"

first=$(docker ps -q --filter "label=$LABEL" | head -1)
echo "-- docker exec 지연 (CLI 포함, 20회 평균)"
s=$(date +%s%N); for i in $(seq 1 20); do docker exec "$first" true; done; e=$(date +%s%N)
echo "평균 $(( (e - s) / 20 / 1000000 )) ms (sandboxd는 API를 직접 써서 CLI 시작 시간만큼 빠르다)"

echo "-- 생성 + 첫 exec"
s=$(date +%s%N)
cold=$(docker run -d --label "$LABEL" "${SECURITY[@]}" "$IMG" sleep infinity)
docker exec "$cold" true
e=$(date +%s%N); echo "$(( (e - s) / 1000000 )) ms"
echo "-- 정지 후 재시작 + 첫 exec"
docker stop -t 1 "$cold" >/dev/null
s=$(date +%s%N); docker start "$cold" >/dev/null; docker exec "$cold" true; e=$(date +%s%N)
echo "$(( (e - s) / 1000000 )) ms"
