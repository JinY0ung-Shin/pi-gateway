# pi-gateway 운영 가이드

설치, 비밀값, sandbox 도구 추가, 네트워크 차단 규칙, 보안 점검, 용량 참고값을 다룬다.
구조와 보안 경계는 [README](../README.md)를 본다.

> 이 문서의 수치는 개발 머신(WSL2, Docker 29.1.3)에서 잰 참고값이다. 운영 용량은 운영 서버에서 다시 확인한다.

## 1. 구성

| 서비스 | 이미지 | 네트워크 | 하는 일 | 가진 비밀 |
|---|---|---|---|---|
| `gateway` | `pi-gateway/gateway` (uid 10001) | edge(포트 공개, 기본 127.0.0.1), control | `/v1/responses`, 관리 화면, pi 세션 | LLM 키, 내부 JWT 키, 관리 키 |
| `sandboxd` | `pi-gateway/sandboxd` (uid 1000 + docker 그룹) | control | 사용자 sandbox 컨테이너 관리, 명령·파일 실행 | docker.sock, sandboxd JWT 키 |
| `mcp-broker` | `pi-gateway/mcp-broker` (root, capability 없음) | control, broker-egress | 원격 MCP 서버 등록·프록시 | MCP 비밀키, KEK |
| `egress-proxy` | `pi-gateway/egress-proxy` (uid 65532, Smokescreen) | proxy-egress | sandbox의 유일한 바깥 출구. 허용 목록의 도메인·IP만 연다 | 없음 |
| `sandbox-image` | `pi-gateway/sandbox` | 없음 | sandbox 이미지 빌드만 하고 끝난다 | 없음 |
| `pi-sbx-<key>` | `pi-gateway/sandbox` (uid 1000) | 없음 (`network_mode: none`) | 사용자별 sandbox. sandboxd가 필요할 때 만들고 유휴 시 지운다 | 없음 |

- **control** 네트워크는 `internal`이다. 바깥으로 나가는 경로가 없고 포트도 공개하지 않는다.
- **sandbox 컨테이너**에는 네트워크가 없다 (인터페이스는 `lo`뿐). 바깥으로는 `proxy-sock` 볼륨의 unix socket을 거쳐 egress-proxy로만 나간다 ([§6](#6-네트워크-차단-규칙)). 그래서 sandbox에서 gateway·broker·sandboxd·다른 sandbox에 닿을 수 없고, 호스트와 사내망에는 허용 목록에 넣은 곳만 닿는다.
- **sandbox 컨테이너**는 compose 밖에서 만들어진다. `docker compose down`으로는 지워지지 않는다 ([§3.5](#35-중지재시작업데이트)).

## 2. 요구사항

- Linux x86_64 호스트, Docker Engine 25 이상 (개발 확인: 29.1.3), Docker Compose v2.
- `openssl`: 비밀값 생성에 쓴다.
- 디스크
  - 이미지: 약 1.5GB (sandbox 568MB, Node 서비스 3개, egress-proxy 14MB)
  - 사용자 workspace: 사용량만큼
- LLM: OpenAI 호환 엔드포인트 (vLLM의 `/v1/chat/completions`) 또는 Anthropic 호환 `/v1/messages`.
  - 도구 호출(function calling)이 켜져 있어야 한다.
  - vLLM이라면 `--enable-auto-tool-choice --tool-call-parser <모델에 맞는 parser>`가 필요하다.

## 3. 설치

### 3.1 호스트 준비

```bash
sudo PI_GATEWAY_HOME=/srv/pi-gateway ./scripts/setup-host.sh
```

`scripts/setup-host.sh`는 이미 있는 것은 건드리지 않고, 다음을 만든다.

| 경로 | 소유자 | 권한 | 용도 |
|---|---|---|---|
| `$PI_GATEWAY_HOME/workspaces` | 1000:1000 | 0700 | 사용자별 workspace (`u-<hash>` 디렉토리) |
| `$PI_GATEWAY_HOME/plugins` | 10001:10001 | 0755 | 설치된 plugin. gateway만 쓰고 sandbox는 읽기만 한다 |
| `$PI_GATEWAY_HOME/secrets/{gateway,sandboxd,broker}` | root | 0700 | compose secret 파일. 파일은 쓰는 서비스 uid 소유의 0400 ([§4](#4-비밀값)) |
| `.env` | – | – | `PI_GATEWAY_HOME`, `PI_GATEWAY_SECRETS`, `DOCKER_GID`를 추가한다 |

**비밀값 파일 권한**
- 디렉토리가 root 0700이라 호스트의 다른 사용자는 읽을 수 없다.
- 파일은 그 비밀값을 쓰는 서비스의 uid만 읽을 수 있다(0400).
- 스크립트를 다시 실행하면 소유자와 권한을 바로잡는다.

**호스트에서 uid 1000이 실제 로그인 사용자인 경우**
- 그 사용자가 모든 workspace의 소유자로 보인다.
- 전용 호스트를 쓰거나, Docker의 `userns-remap`을 켜서 컨테이너 uid가 다른 호스트 uid로 매핑되게 한다.

### 3.2 `.env` 작성

```bash
cp .env.example .env    # setup-host.sh가 이미 만들었다면 아래 값만 추가한다
```

확인할 값은 다음과 같다.

- `$PI_GATEWAY_SECRETS/gateway/user_api_keys`: 사용자별 키를 쓸 때. 형식은 `{"alice":"<32자 이상 키>","bob":"..."}`
  - 편집한 뒤 소유자 10001, 권한 0400을 유지한다 (`sudo ./scripts/setup-host.sh`를 다시 실행하면 바로잡는다).
- `GATEWAY_BIND_ADDR`: 기본 `127.0.0.1`. 같은 호스트의 reverse proxy(TLS) 뒤에 두는 것을 권장한다. 직접 공개하려면 LAN IP나 `0.0.0.0`으로 바꾼다.

모든 변수의 설명은 `.env.example`에 있다.

### 3.3 빌드와 시작

```bash
docker compose up -d --build
docker compose ps                 # gateway, sandboxd, mcp-broker, egress-proxy가 healthy, sandbox-image는 exited (0)
curl -fsS http://127.0.0.1:8080/healthz
```

그다음 관리 화면(`/admin`, 키는 `$PI_GATEWAY_SECRETS/gateway/admin_api_key`)의 **LLM** 페이지에서 LLM을 설정한다. 설정하기 전에는 `/v1/responses`가 503(`llm_not_configured`)이다.
- LLM 서버마다 id, API 형식, base URL(예: `http://vllm.internal:8000/v1`), API 키(없으면 비운다), 모델 목록을 넣고, 전체에서 기본 모델 하나를 고른다. vLLM은 보통 서버 하나에 모델 하나이므로 모델마다 서버를 추가한다.
- 모델 id는 서버끼리 겹치면 안 된다. `GET /v1/models`의 `owned_by`가 서버 id다.
- **모델 가져오기**는 서버의 `/v1/models`에서 목록을 받아 고르게 한다 (vLLM이면 `contextWindow`가 `--max-model-len`으로 채워진다). 직접 넣을 때도 `contextWindow`는 `--max-model-len`과 맞춘다.
- 페이지를 열면 서버마다 연결·인증을 확인하고 등록한 모델이 서버에 있는지 표시한다. 모델의 **테스트**는 짧은 요청을 실제로 보내 본다. 둘 다 저장하기 전 입력값으로 할 수 있다.
- 설정은 gateway DB(`/data/gateway.db`)에 저장되고 저장하는 즉시 적용된다. 메모리의 세션은 다음 턴에 새 설정으로 다시 열린다. 키는 관리 화면에 다시 보이지 않는다.

기동 순서는 다음과 같다.
1. `sandbox-image` 빌드가 끝나고, `egress-proxy`가 healthy가 된다.
2. `sandboxd`가 시작된다. 이때 프록시 socket 볼륨을 확인하고, 남아 있던 sandbox를 채택한다.
3. `mcp-broker`가 시작된다.
4. `gateway`가 시작된다.

### 3.4 운영 배포 권장 설정

| 설정 | 권장값 | 이유 |
|---|---|---|
| `GATEWAY_BIND_ADDR` | `127.0.0.1` (기본) | 같은 호스트의 reverse proxy(nginx 등)가 TLS를 맡고 이 포트로 넘긴다. LAN에서 gateway 포트에 바로 닿지 않는다 |
| `TRUST_PROXY` | 프록시 IP/CIDR 목록 (예: `172.18.0.1`) | 클라이언트 IP를 X-Forwarded-For에서 읽어, 관리 화면 로그인 잠금(IP별)이 실제 클라이언트 기준으로 동작하게 한다. **IP/CIDR 목록만 받는다.** hop 수와 `true`(아무 클라이언트나 IP를 속일 수 있다)는 거부한다. 직접 공개할 때는 `false` |
| `SANDBOX_EGRESS_ALLOW` | sandbox가 써야 하는 도메인·IP만 | 목록에 없는 목적지는 모두 막힌다. 호스트 주소나 넓은 CIDR을 넣으면 그 안의 모든 서비스가 열리므로 포트까지 적는다 ([§6](#6-네트워크-차단-규칙)) |
| `SANDBOX_RUNTIME` | `runsc` (gVisor), `SANDBOX_PIDS_LIMIT=4096`과 함께 | sandbox의 시스템 콜을 호스트 커널 대신 gVisor가 처리한다. 설치와 필요한 옵션은 [§7](#7-gvisorrunsc로-커널-분리하기) |
| `MCP_METADATA_KEYS` | `THREAD_ID,ORCHESTRATOR_URL` | 기존 클라이언트가 보내는 키만 MCP 템플릿에 넘긴다. metadata에는 비밀값을 담지 않는다 |
| `NODE_EXTRA_CA_CERTS` | 사내 CA PEM 파일의 호스트 경로 (필요할 때만) | LLM 엔드포인트, 사내 git 저장소(plugin marketplace), 원격 MCP 서버가 사내 CA 인증서를 쓰면 gateway와 gateway가 실행하는 git, mcp-broker가 그 CA를 믿게 한다. compose가 gateway·mcp-broker 컨테이너에 읽기 전용으로 mount한다 |

`TRUST_PROXY`에 넣을 주소: `GATEWAY_BIND_ADDR=127.0.0.1`로 공개한 포트에 같은 호스트의 nginx가 연결하면, Docker의 userland-proxy를 거치므로 gateway에는 edge 네트워크의 gateway IP에서 온 연결로 보인다.

```bash
docker network inspect pi-gateway_edge --format '{{(index .IPAM.Config 0).Gateway}}'   # 예: 172.18.0.1 → TRUST_PROXY=172.18.0.1
```

- 이 주소는 네트워크를 다시 만들면 바뀔 수 있다. 고정하려면 `docker-compose.override.yml`에서 `networks.edge.ipam`으로 대역을 정한다.
- dockerd를 `--userland-proxy=false`로 운영한다면 `127.0.0.1`도 함께 넣는다 (예: `TRUST_PROXY=172.18.0.1,127.0.0.1`).

nginx 예시 (같은 호스트, TLS 종료):

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;          # SSE 스트리밍
  proxy_read_timeout 3600s;
}
```

### 3.5 중지·재시작·업데이트

```bash
docker compose down                     # 서비스만 내린다. 사용자 sandbox 컨테이너는 남는다
docker compose up -d --build            # 업데이트. sandboxd가 실행 중인 sandbox를 다시 채택한다
docker ps --filter label=pi-gateway.sandbox=1          # 사용자 sandbox 목록
docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)   # 모든 sandbox 제거 (workspace는 남는다)
```

**sandbox 이미지를 바꿨을 때**
- 실행 중인 sandbox는 유휴 시간(`SANDBOX_IDLE_SECONDS`)이 지나 정리될 때까지 이전 이미지를 쓴다.
- 바로 적용하려면 위의 `docker rm -f` 명령으로 sandbox를 지운다. 다음 도구 호출 때 새 이미지로 다시 만든다.

## 4. 비밀값

같이 쓰는 값은 서비스마다 **같은 값의 사본**을 둔다. 각 파일은 그 서비스 uid 소유의 0400이다.

| 파일 (`$PI_GATEWAY_SECRETS/…`) | 소유자 | 컨테이너 안 경로 | 내용 |
|---|---|---|---|
| `gateway/api_key` | 10001 | gateway | 서비스 키 (`body.user`를 믿는다, BFF용). 빈 파일이면 끈다 |
| `gateway/user_api_keys` | 10001 | gateway | `{"사용자":"키"}`. 키가 사용자를 정한다 |
| `gateway/admin_api_key` | 10001 | gateway | 관리 화면 로그인 키. 빈 파일이면 관리 화면이 꺼진다 |
| `gateway/sandboxd_jwt_secret`, `sandboxd/sandboxd_jwt_secret` | 10001 / 1000 | gateway / sandboxd | gateway→sandboxd 내부 JWT (HS256, 32바이트 이상). **두 사본이 같은 값이어야 한다** |
| `gateway/broker_jwt_secret`, `broker/broker_jwt_secret` | 10001 / root | gateway / mcp-broker | gateway→broker 내부 JWT (MCP 호출과 관리 API 모두). 두 사본이 같은 값 |
| `broker/broker_kek` | root | mcp-broker | MCP 비밀키 암호화 키. 정확히 32바이트를 base64로 |

**교체**
- 같이 쓰는 값은 두 사본을 모두 바꾸고, 쓰는 서비스를 모두 다시 시작한다. 예: `docker compose up -d --force-recreate gateway sandboxd`
- 바꾼 뒤 `sudo ./scripts/setup-host.sh`를 실행하면 두 사본이 같은지 확인하고 권한을 바로잡는다. 사본이 다르면 멈춘다.

**`broker_kek` 주의**: 바꾸면 기존에 저장된 MCP 비밀키를 복호화할 수 없다. 바꾼 뒤 관리 화면에서 MCP 키를 다시 입력한다.

**확인**
- `./scripts/security-check/check-secret-files.sh`가 실행 중인 컨테이너에서 다음을 확인한다 ([§8](#8-보안-점검)).
  - 각 서비스의 `/run/secrets/*` 소유자와 권한.
  - sandbox 컨테이너에 `/run/secrets`가 없는지.
- 비밀값은 sandbox 컨테이너, gateway의 일반 환경변수, 로그에 들어가지 않는다.

## 5. sandbox에 도구 추가하기

기본 이미지 도구:

| 분류 | 도구 |
|---|---|
| 셸·기본 | bash, coreutils, procps, less, file, zip/unzip, xz |
| 언어 | Python 3.12 (pip, venv), Node 22 (npm) |
| 네트워크·Git | git, curl, wget |
| 검색·처리 | jq, ripgrep, fd |

**agent가 직접 설치하는 경우**
- `pip install`과 `npm install -g`는 agent의 workspace(`/workspace/.home`) 안에 설치된다.
- 사용자마다 따로이고, 재시작해도 남는다.

**관리자가 미리 넣는 경우**: 모든 사용자가 같이 쓰는 도구는 기본 이미지를 `FROM`으로 쓰는 파생 이미지에 시스템 경로로 설치하고, `.env`의 `SANDBOX_IMAGE`로 지정한 뒤 `docker compose up -d sandboxd`와 `docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)`로 적용한다 (workspace는 남는다). 마지막 `USER`는 `1000:1000`이어야 하고, `/usr/local/bin/sbx-run`·`sbx-fs`·`sbx-proxy-bridge`와 `/usr/local/lib/pi-sbx`는 그대로 둔다. 설치 뒤 setuid/setgid 비트를 지우고(`find / -xdev -perm /6000 -type f -exec chmod a-s {} +`), 비밀값은 넣지 않는다.

```dockerfile
FROM pi-gateway/sandbox:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-core && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir --root-user-action=ignore python-docx \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} +
USER 1000:1000
```

## 6. 네트워크 차단 규칙

sandbox 컨테이너에는 네트워크가 없다 (`network_mode: none`, 인터페이스는 `lo`뿐). 바깥으로 나가는 길은 egress 프록시 하나다.

```
sandbox의 프로그램 ─HTTP(S)_PROXY→ 127.0.0.1:3128 (sbx-proxy-bridge, sandbox 안)
  ─unix socket (proxy-sock 볼륨, 읽기 전용 mount)→ egress-proxy (Smokescreen) ─proxy-egress 네트워크→ 허용 목록의 목적지
```

- 정책은 "허용 목록(`SANDBOX_EGRESS_ALLOW`)에 있는 목적지만 연다"이다. 비우면 모두 막힌다. 호스트 방화벽(iptables) 설정은 필요 없다.
- sandbox에는 경로와 DNS가 없다. 프록시를 거치지 않는 연결(직접 TCP·UDP·DNS)은 모두 실패한다.
- 프록시는 HTTP CONNECT(HTTPS 등)와 일반 HTTP를 받는다. 목적지 이름은 프록시가 해석하고, 해석된 IP로 연결한다 (DNS rebinding으로 우회할 수 없다). UDP와 프록시를 쓰지 않는 연결(예: 프록시 설정 없는 SSH)은 나가지 못한다. Git은 HTTPS URL을 쓴다.
- sandbox의 env: `HTTP_PROXY`·`HTTPS_PROXY`(소문자도) = `http://127.0.0.1:3128`, `NO_PROXY=localhost,127.0.0.1,::1`, `NODE_USE_ENV_PROXY=1`(Node의 전역 `fetch`가 프록시를 따르게 한다). curl·pip·npm·git·Python requests는 이 env를 따른다.
- egress-proxy는 TCP 포트를 열지 않고 unix socket에서만 듣는다. proxy-egress 네트워크에는 egress-proxy만 붙는다.
- 요청마다 JSON 한 줄이 남는다: `docker compose logs egress-proxy` (`CANONICAL-PROXY-DECISION`의 `requested_host`, `allow`, `decision_reason`). 모든 sandbox가 같은 socket을 쓰므로 로그에서 sandbox(사용자)를 구분할 수는 없다.

**허용 목록** (`.env`의 `SANDBOX_EGRESS_ALLOW`. 바꾼 뒤 `docker compose up -d egress-proxy`. 실행 중인 sandbox는 다시 만들 필요 없다)

```bash
SANDBOX_EGRESS_ALLOW=github.corp.com:443,nexus.corp.com,10.1.2.3:8080,10.20.0.0/16
```

| 항목 | 뜻 |
|---|---|
| `github.corp.com` | 그 도메인의 모든 포트. 이름이 정확히 같아야 한다 (하위 도메인·와일드카드는 열리지 않는다) |
| `github.corp.com:443` | 그 도메인의 443만 |
| `10.1.2.3`, `10.1.2.3:8080` | 그 IP (의 그 포트). 요청에 IP를 직접 쓴 경우에만 맞는다 |
| `10.20.0.0/16`, `10.20.0.0/16:443` | 그 대역 (의 그 포트) |

- 도메인 항목은 요청에 쓴 이름으로 판단한다. `https://10.1.2.3/`처럼 IP로 부르면 IP 항목이 있어야 한다.
- 도메인이 loopback(`127.0.0.0/8`)이나 link-local(`169.254.0.0/16`, 클라우드 metadata 포함)로 해석되면 허용 목록에 있어도 거부한다. 이 대역과 겹치는 IP 항목(`0.0.0.0/0` 포함)이 있으면 프록시가 시작하지 않는다.
- IP는 egress-proxy 컨테이너에서 본 주소다. sandbox에는 네트워크가 없으므로, 연결을 실제로 만드는 쪽은 프록시다.
- 호스트 주소나 넓은 CIDR을 넣으면 그 안의 SSH·공개 포트도 열린다. 필요한 포트까지 적는다.
- 거부된 요청은 `407 Request rejected by proxy`를 받는다.

**같은 호스트의 MonSemi orchestrator 예시**

monsemi-frontend MCP 서버는 사용자 sandbox 안에서 돌면서 orchestrator(`SERVICE_URL`/`ORCHESTRATOR_URL`)를 부른다. 이 연결도 프록시를 거친다 (Node `fetch` + `NODE_USE_ENV_PROXY=1`).

1. 프록시에서 orchestrator에 닿는 주소를 정한다.
   - orchestrator가 호스트에서 직접 돌거나 Docker로 `19090:...`처럼 공개돼 있으면 **호스트의 LAN IP**를 쓴다: `http://192.168.10.5:19090`.
   - proxy-egress 네트워크의 gateway 주소로도 호스트에 닿는다 (`docker network inspect pi-gateway_proxy-egress --format '{{(index .IPAM.Config 0).Gateway}}'`, 예: `172.19.0.1`). 다만 네트워크를 다시 만들면 바뀔 수 있으므로 LAN IP를 권장한다.
   - 다른 호스트의 orchestrator는 그 주소 그대로 쓴다: `http://10.1.2.3:9000`.
   - 호스트의 방화벽이 Docker bridge에서 오는 연결을 막는다면 그 포트를 열어야 한다.
2. 그 주소를 MCP 템플릿 값(요청 metadata `ORCHESTRATOR_URL`) 또는 서버 설정의 `SERVICE_URL`로 쓴다.
3. 그 주소·포트를 허용 목록에 넣고 프록시를 다시 띄운다.

```bash
# .env
SANDBOX_EGRESS_ALLOW=192.168.10.5:19090

docker compose up -d egress-proxy
```

- 허용하지 않은 나머지(같은 호스트의 다른 포트, 다른 주소, metadata)는 계속 막힌다.
- 적용한 뒤에는 [§8 보안 점검](#8-보안-점검)으로 확인한다.

## 7. gVisor(runsc)로 커널 분리하기

일반 컨테이너(runc)는 호스트 커널을 공유한다. gVisor(`runsc`)를 쓰면 sandbox의 시스템 콜을 호스트 커널 대신 sandbox마다 붙는 gVisor 커널이 처리한다. 커널 공격 표면이 줄고, sandbox에서 호스트 커널 버전과 CPU·메모리 총량도 보이지 않는다. 코드는 그대로이고 Docker 런타임 설정만 바꾼다.

```bash
# 1) 설치: 사내 apt 미러
sudo apt-get update && sudo apt-get install -y runsc
runsc --version
# 2) Docker 런타임 등록: /etc/docker/daemon.json의 runtimes에 runsc만 더한다 (다른 설정은 그대로 둔다)
sudo runsc install -- --host-uds=open --oci-seccomp
# 설정만 다시 읽는다 (컨테이너는 재시작되지 않는다). reload는 신호만 보내고 끝나므로 잠깐 기다린다
sudo systemctl reload docker && sleep 3
docker run --rm --runtime=runsc pi-gateway/sandbox:latest uname -r   # 호스트와 다른 커널 버전이 나오면 된다
# 3) .env
SANDBOX_RUNTIME=runsc
SANDBOX_PIDS_LIMIT=4096
docker compose up -d sandboxd
docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)
```

- `--host-uds=open`: sandbox의 유일한 바깥 출구는 egress 프록시의 unix socket이다 ([§6](#6-네트워크-차단-규칙)). runsc는 기본으로 호스트 unix socket 연결을 막으므로, 빠지면 모든 바깥 요청이 끊긴다. 열리는 것은 sandbox에 mount된 socket(프록시 socket)뿐이다.
- `--oci-seccomp`: runsc는 기본으로 Docker의 seccomp 프로필을 sandbox 안에 걸지 않는다. 빠지면 sandbox 안에서 user namespace를 만들 수 있어 보안 점검이 FAIL이다.
- `SANDBOX_PIDS_LIMIT`: gVisor 커널의 호스트 스레드와 stub 프로세스도 이 제한에 들어간다. 256이면 fd·rg처럼 스레드를 많이 쓰는 도구에서 sandbox가 통째로 죽는다 (`WaitPID ... failed: EOF`). 4096에서 시작해 운영에서 `pids.peak`를 보고 맞춘다 (cgroup v2, systemd 드라이버):
  `cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' <sandbox 컨테이너>).scope/pids.peak`
- 파일 조작이 한 번에 약 60ms 느려지고, sandbox마다 메모리가 약 17MB 더 든다 ([§9](#9-용량-참고값)).
- 기본 platform(systrap)이 `failed to create a syscall thread`로 죽는 커널(예: WSL2 개발 머신)에서는 개발용으로만 runtimeArgs에 `--platform=ptrace`를 더한다 (느리다).
- 되돌리기: `.env`의 `SANDBOX_RUNTIME`을 비우고, `docker compose up -d sandboxd`와 위의 `docker rm -f` 명령을 실행한다.

적용한 뒤 보안 점검([§8](#8-보안-점검))을 `--strict`로 다시 돌린다.

## 8. 보안 점검

두 가지 점검을 돌린다.

**1) sandbox 격리 점검: `scripts/security-check/run.mjs`**
1. 살아 있는 sandboxd에 점검용 사용자 두 명(secchk-a, secchk-b)의 sandbox를 만든다.
2. 그 안에서 실제로 격리를 깨려고 시도한다.
3. 결과를 Markdown 리포트로 남긴다. 보안부서에 그대로 제출할 수 있다.

```bash
# 운영 서버: sandboxd 컨테이너 안에서 돌린다 (비밀키·내부 서비스 이름을 자동으로 쓴다)
docker compose exec -T sandboxd node --input-type=module - \
  --host-ip "$(hostname -I | awk '{print $1}')" --host-ports 22,80,443,2375,2376,8080 \
  < scripts/security-check/run.mjs > security-report.md
echo $?    # 0 = 실패 없음, 1 = FAIL/INVALID 있음, 2 = 실행 실패
```

**2) 비밀 파일 권한 점검: `scripts/security-check/check-secret-files.sh`**

```bash
./scripts/security-check/check-secret-files.sh     # docker compose 인자를 그대로 넘길 수 있다 (-p, --env-file)
```

- 각 서비스의 `/run/secrets/*`가 그 서비스 uid 소유의 0400인지 본다.
- 실행 중인 sandbox 컨테이너에 `/run/secrets`가 없는지 본다.

**점검 항목 (run.mjs)**

| 영역 | 항목 |
|---|---|
| workspace | 다른 사용자 파일(find·grep 전체 검색), 호스트 경로 추측, mount 목록 |
| 프로세스 | 다른 사용자의 프로세스·명령줄 |
| 비밀값 | 환경변수, 알려진 비밀값의 해시 검색. 비밀값 자체는 sandbox로 보내지 않는다 |
| `/etc` | `/etc/passwd` 계정, hostname, shadow 파일 |
| 권한 | uid, capability, no_new_privs, setuid 파일, su·sudo·user namespace·mount, seccomp |
| 파일시스템 | `/workspace`·`/tmp` 밖 쓰기, docker.sock |
| 네트워크 | 내부 서비스(gateway·sandboxd·broker), metadata 주소, 허용 목록에 없는 목적지, 다른 sandbox, 호스트 주소. 각각 직접 연결과 egress 프록시 경유를 둘 다 시도한다 |
| 참고 | 사내망 대상 도달 여부(`--lan`, 프록시 경유), 자원 제한, 커널 정보 |

**네트워크 판정**

| 대상 | FAIL | WARN | PASS |
|---|---|---|---|
| 호스트 주소 (`--host-ip`) | 직접 또는 프록시로 열린 포트가 있다 | 열린 포트는 없지만 프록시가 그 주소를 거부하지 않는다 (허용 목록에 들어 있다) | 직접 경로가 없고 프록시가 모든 포트를 거부한다 (407) |
| 허용 목록에 없는 목적지 | 프록시가 거부하지 않는다 | – | 프록시가 거부한다 (407) |
| metadata 주소 | 직접 연결되거나 프록시가 거부하지 않는다 | – | 직접 경로가 없고 프록시가 거부한다 |
| 다른 sandbox | loopback 밖의 인터페이스가 있다 | – | 인터페이스가 `lo`뿐이다 |

- 대조군(`--egress HOST:PORT`)에는 허용 목록에 있는 대상 하나를 준다. 프록시로 연결되지 않으면 egress-proxy가 멈췄거나 그 대상이 꺼져 있다. 주지 않으면 대조군 없이 점검한다.
- `--host-ip`에는 호스트의 LAN 주소와 공인 주소를 준다. `SANDBOX_EGRESS_ALLOW`로 연 포트는 열린 포트로 보이므로 `--host-ports`에서 뺀다.
- `--lan IP:PORT`(또는 도메인:포트)는 허용 목록이 의도대로인지 보는 용도라 결과를 INFO로만 낸다.

**결과 해석**
- 차단 항목마다 **대조군**이 있다. 같은 방법으로 일부러 만든 "보여야 하는 것"이 실제로 보이는지 확인한다.
  - 대조군이 실패하면 그 항목은 `INVALID`이고 실패로 센다. 검사 방법이 틀려서 통과하는 일을 막기 위해서다.
- sandbox의 `/etc/resolv.conf`에는 Docker가 호스트의 nameserver·search domain을 그대로 넣는다. sandbox에는 네트워크가 없어 그 주소로 갈 수는 없지만 사내 DNS 주소는 보인다. 운영 서버에서 돌린 리포트의 "/etc 내용" 상세에서 무엇이 보이는지 확인한다.
- `WARN`은 허용 목록이 호스트 주소를 열어 둔 항목이다. `--strict`를 주면 실패로 센다. 운영에서는 `--strict`를 권장한다.
- 기타 옵션: `--internal 이름:포트`(내부 서비스 추가), `--keep`(점검용 workspace 보존).

## 9. 용량 참고값

개발 머신에서 잰 값이다. 운영 서버에서는 다시 확인한다.

| 항목 | 값 |
|---|---|
| 유휴 sandbox 컨테이너 | 약 13–15MB (containerd-shim 약 11MB 포함) |
| 컨테이너 생성 | 약 0.4초 (첫 도구 호출 때 한 번) |
| docker exec 한 번 | 약 40–50ms (runc exec 비용) |
| sandboxd 파일 조작 | 약 60ms |
| pi 세션 | 대화 기록 크기 정도 (120KB 기록 → 약 0.1MB, 1MB 기록 → 약 1.1MB) |
| gateway 프로세스 기본 | 약 135MB |

gVisor(`SANDBOX_RUNTIME=runsc`)면 sandbox마다 메모리가 약 17MB 더 들고(유휴 cgroup 기준 1.3MB → 18.5MB), 파일 조작은 약 120ms, 컨테이너 생성은 약 0.45초다. 쓰고 난 메모리는 호스트로 돌아온다. 개발 머신에서 ptrace platform으로 잰 값이라 운영(systrap)에서 다시 잰다.

**용량 계산**: 동시에 활동하는 사용자 수 × (sandbox 오버헤드 + agent가 돌리는 프로그램) + gateway 기본 + 세션 수 × 기록 크기.

컨테이너별 상한은 `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_PIDS_LIMIT`로 건다.

## 10. 운영 메모

**로그**
- `docker compose logs -f sandboxd gateway mcp-broker egress-proxy`
- sandbox 컨테이너는 로그를 남기지 않는다 (`LogConfig: none`). 명령 출력은 gateway 세션 기록에 있다.

**workspace**
- 위치: `$PI_GATEWAY_HOME/workspaces/u-<sha256(user)[:24]>`
- 백업은 이 디렉토리를 대상으로 한다.
- 사용자 id에서 디렉토리 이름을 구하는 방법: `node -e "console.log('u-'+require('crypto').createHash('sha256').update('alice').digest('hex').slice(0,24))"`

**디스크 quota**
- 하드 quota는 걸지 않는다. 필요하면 workspaces를 XFS(`prjquota`) 볼륨에 두고 디렉토리별 project quota를 건다.

**유휴 정리**

| 대상 | 기본 시간 | 동작 |
|---|---|---|
| sandbox | 15분 (`SANDBOX_IDLE_SECONDS`) | 컨테이너를 제거한다. workspace는 남는다 |
| gateway 세션 | 5분 (`SESSION_IDLE_SECONDS`) | 메모리에서 내린다. 다음 요청 때 기록에서 되살린다 |
| 대화 기록 | 지우지 않음 (관리 화면 "대화 기록"의 보관 기간) | 마지막 활동 뒤 기간이 지나면 세션 기록(JSONL)과 메타를 지운다. workspace는 남는다 |

**sandboxd 재시작**
- 실행 중인 sandbox는 그대로 둔다. 다시 시작할 때 label(`pi-gateway.instance`)로 찾아 채택한다.
- 멈춘 sandbox는 지운다. 다음 요청 때 현재 설정으로 다시 만든다.
- 스펙 버전 label(`pi-gateway.spec`)이 다른 sandbox는 실행 중이어도 지우고 다시 만든다.

**문제 해결**

| 증상 | 원인과 조치 |
|---|---|
| sandboxd 로그에 `sandbox image not found` | `docker compose build sandbox-image` |
| `permission denied ... docker.sock` | `.env`의 `DOCKER_GID`가 `stat -c %g /var/run/docker.sock` 값과 다르다 |
| `WORKSPACES_DIR does not exist`, bind mount 오류 | `$PI_GATEWAY_HOME/workspaces`가 없거나 소유자가 1000이 아니다 (`setup-host.sh`) |
| 도구 호출이 `sandbox_unavailable` | `docker compose logs sandboxd`로 Docker API 오류를 본다 |
| sandboxd 로그에 `unknown or invalid runtime name: runsc` | runsc를 Docker에 등록하지 않았거나, `systemctl reload docker` 직후라 아직 다시 읽지 않았다 ([§7](#7-gvisorrunsc로-커널-분리하기)) |
| (runsc) 명령이 exit 128로 끝나고 `WaitPID ... failed: EOF`가 남는다 | sandbox의 gVisor 커널이 죽었다. 대개 `SANDBOX_PIDS_LIMIT`가 작아서다 ([§7](#7-gvisorrunsc로-커널-분리하기)) |
| 컨테이너 수를 제한하고 싶다 | 유휴 시간을 줄이거나 호스트 메모리에 맞춰 `SANDBOX_MEMORY`를 조정한다 |
| plugin 설치 실패 | gateway 컨테이너에서 Git 저장소에 닿는지 확인한다 (edge 네트워크) |
| sandbox에서 바깥 요청이 `407`로 실패한다 | 허용 목록에 없는 목적지다 (도메인은 정확히 같은 이름, 포트를 적었다면 그 포트만). 이유는 `docker compose logs egress-proxy`의 `decision_reason`. 열어야 하면 `SANDBOX_EGRESS_ALLOW`에 넣는다 ([§6](#6-네트워크-차단-규칙)) |
| sandbox에서 모든 바깥 요청이 바로 끊긴다 (curl `(56) Recv failure: Connection reset by peer`) | egress-proxy가 멈췄다. `docker compose ps egress-proxy`, `docker compose logs egress-proxy` (설정 값이 잘못되면 시작하지 않는다) |
| 특정 도구만 바깥에 나가지 못한다 (`Could not resolve host`) | 그 도구가 `HTTP(S)_PROXY` env를 따르지 않는다. sandbox에는 DNS가 없다. 도구의 프록시 설정에 `http://127.0.0.1:3128`을 넣는다 |

## 11. mcp-broker

- **비밀키가 필요한 MCP 서버**: 원격 HTTP(streamable HTTP) 서버만 broker에 등록한다. broker가 `{{secret:NAME}}` 값을 헤더·URL에 붙여 프록시한다. broker는 프로세스(stdio 서버)를 실행하지 않는다.
- **비밀키 없는 MCP 서버** (예: monsemi-frontend): broker가 아니라 사용자 sandbox 안에서 stdio로 돈다. 관리 화면에서 `runIn: sandbox`로 등록한다.
