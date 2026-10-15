# pi-gateway 설계

`oh-my-gateway`(Claude Agent SDK 기반)를 [pi](https://github.com/earendil-works/pi)로 처음부터 다시 만든다.
목표는 **세션당 메모리를 줄이는 것**이고, 기능은 필요한 것만 옮긴다.

- 작성일: 2026-10-16
- 기준 버전: pi 1.2.0 (`@earendil-works/*`), Node 22.19+

## 1. 범위

### v1에 포함

| 요구사항 | 설계 요약 |
|---|---|
| `POST /v1/responses` | OpenAI Responses 호환. `oh-my-gateway`의 요청·응답·SSE 계약을 유지한다 (§6). |
| Docker 배포 | docker compose. 고정 서비스 3개에 사용자별 sandbox 컨테이너가 붙는다 (§13). |
| 사용자별 workspace 격리 | agent의 모든 도구 실행을 사용자별 컨테이너에서 한다. workspace 밖은 OS 수준에서 보이지 않는다 (§3). |
| MCP 키 격리 | 비밀키는 `mcp-broker`에만 있다. agent, gateway 디스크, sandbox 어디에도 없다 (§8). |
| Claude marketplace plugin 설치 | skills, commands, `.mcp.json`을 지원한다 (§9). |
| AskUserQuestion | `requires_action`과 `function_call`을 쓰고, `function_call_output`으로 답을 받는다 (§7). |
| 시스템 프롬프트 관리 | 버전, 배포, 롤백, 미리보기를 지원한다 (§10). |
| 웹 관리 화면 | 프롬프트, MCP, plugin을 관리한다 (§11). |

### v1에서 제외 (필요해지면 추가)

- `GET`/`DELETE /v1/responses/{id}`, cancel, `background` 모드
- `text.format` (json_schema), 이미지 입력
- plugin의 hooks, agents(subagent), LSP, workflows, userConfig
- MCP의 사용자별 저장 키와 OAuth 연결. v1은 org 공용 키와 요청 헤더로 전달되는 사용자 토큰만 지원한다.
- `/v1/agents/messages`, `/v1/messages` 프록시, Codex/OpenCode backend

## 2. 전체 구조

```
                ┌──────────────────────── docker compose ────────────────────────┐
 client ─HTTPS─▶│ gateway (Node 22 + pi SDK) ── edge, control 네트워크            │
                │  · /v1/responses, /admin (웹 UI + API)                          │
                │  · pi AgentSession들 (한 프로세스 안의 객체)                    │
                │  · LLM 키, 세션 기록(JSONL), SQLite (프롬프트·plugin·MCP 목록)  │
                │  · 사용자 파일을 직접 읽거나 명령을 직접 실행하지 않는다       │
                │       │ 도구 실행 (HTTP + JWT)          │ MCP 호출 (JWT)        │
                │       ▼                                 ▼                       │
                │  sandboxd ── control             mcp-broker ── control, egress  │
                │  · docker.sock을 가진 유일한 곳   · MCP 비밀키 (AES-GCM 저장)   │
                │  · 정해진 스펙으로만 컨테이너 생성 · 키가 필요한 stdio 서버 실행 │
                │       │                          · 원격 MCP에 인증 헤더 주입    │
                │       ▼                          · 결과에서 비밀값 가리기       │
                │  sbx-<userKey> … (사용자별, 네트워크 없음 · 외부는 프록시로만)   │
                │  · /workspace = 본인 workspace만 mount (rw)                     │
                │  · /opt/plugins = 설치된 plugin (ro)                            │
                │  · 비밀키 없음. gateway, broker, sandboxd에 닿지 않음           │
                │  · 비밀키 없는 MCP 서버 (예: monsemi-frontend)가 여기서 돈다    │
                └─────────────────────────────────────────────────────────────────┘
```

### 컴포넌트 책임

| 컴포넌트 | 위치 | 하는 일 | 갖고 있는 비밀 |
|---|---|---|---|
| gateway | `apps/gateway` | HTTP API, 인증, 세션, pi agent loop, 도구 호출 중계, plugin 설치, 프롬프트, 관리 UI | LLM 키, 내부 JWT 서명키, broker admin 토큰 |
| sandboxd | `apps/sandboxd` | 사용자 컨테이너 생성·중지, 명령 실행, 파일 조작, 장기 프로세스 attach | docker.sock |
| mcp-broker | `apps/mcp-broker` | MCP 서버 등록, 비밀키 보관, MCP 프록시 | MCP 비밀키, 암호화 키(KEK) |
| sandbox 이미지 | `images/sandbox` | agent가 쓰는 Linux 환경 (bash, python, node, git, curl, jq, rg, fd …) | 없음 |
| admin-ui | `apps/admin-ui` | 관리 화면 SPA. gateway가 정적 파일로 서빙한다. | 없음 |
| shared | `packages/shared` | 컴포넌트 간 계약 (zod 스키마, 타입, 내부 JWT, userKey) | – |

## 3. 보안 경계

**핵심 원칙: agent loop(LLM 호출)는 gateway에서, 도구 실행은 sandbox에서.**
agent가 만든 코드와 명령은 비밀이 하나도 없는 컨테이너 안에서만 돈다.

### sandbox 컨테이너 스펙

sandboxd가 고정값으로만 만든다. 호출자가 스펙을 바꿀 수 없다.

| 항목 | 값 |
|---|---|
| 이미지 | `SANDBOX_IMAGE` (`images/sandbox`) |
| 실행 사용자 | uid/gid 1000 (`agent`). `/etc/passwd`에는 `root`와 `agent`만 있다. |
| 파일시스템 | `--read-only` rootfs, `--tmpfs /tmp` (크기 제한) |
| 권한 | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--init` |
| 자원 제한 | `--memory`, `--cpus`, `--pids-limit` |
| hostname | `sandbox` 고정 |
| mount | `<WORKSPACES_HOST_DIR>/<userKey>` → `/workspace` (rw)<br>`<PLUGINS_HOST_DIR>` → `/opt/plugins` (ro)<br>그 외는 없다. docker.sock, 다른 사용자, gateway 데이터는 mount하지 않는다. |
| 환경 | `HOME=/workspace/.home`. pip는 user 설치로 workspace에 들어가고, npm global prefix도 workspace 안이다. |
| 네트워크 | `network_mode: none`. 바깥으로는 `egress-proxy`의 unix socket을 거쳐 HTTP/HTTPS로만 나간다 (`HTTP(S)_PROXY=127.0.0.1:3128`). 프록시는 호스트·사설·metadata 대역을 거부하고, `SANDBOX_EGRESS_ALLOW`만 예외로 연다. |
| label | `pi-gateway.sandbox=1`, `pi-gateway.user-key=<userKey>` (시작할 때 고아 컨테이너 정리용) |

- `userKey = "u-" + sha256(userId)[:24]`. 컨테이너 이름과 디렉토리 이름에 원래 사용자 id를 쓰지 않는다.
- 익명 요청(사용자 없음)은 principal을 `_anon-<sessionId>`로 둔다. 세션이 끝나면 컨테이너와 workspace를 지운다.
  `_`로 시작하므로 실제 사용자 id 패턴과 겹칠 수 없다.

### agent가 볼 수 없는 것

| 대상 | 보이지 않는 이유 |
|---|---|
| 다른 사용자 workspace | 컨테이너가 다르고, mount하지 않았다. |
| 다른 사용자 프로세스 (`/proc`) | PID namespace가 분리돼 있다. |
| gateway·broker의 env, 메모리, 파일 | 다른 컨테이너에 있다. |
| LLM 키, MCP 키, 세션 JSONL | gateway·broker 볼륨에만 있다. |
| 서버의 `/etc` | sandbox 이미지의 최소한의 `/etc`만 보인다. |
| 내부 서비스·호스트·다른 sandbox 접근 | sandbox에는 네트워크가 없다. 프록시가 사설·호스트 주소를 거부한다. |

### 남는 위험과 대응

| 위험 | 대응 |
|---|---|
| 서버 kernel 버전, CPU·메모리 총량이 보인다 (kernel 공유) | 필요하면 gVisor(`runsc`) runtime으로 바꾼다. 설정 하나로 전환할 수 있다. |
| docker.sock을 가진 sandboxd가 뚫리면 호스트가 위험하다 | sandboxd를 작게 유지하고 control 네트워크만 쓴다. 인증 토큰을 요구하고, 컨테이너 스펙은 코드에 고정한다. |

### 내부 인증

- gateway가 sandboxd와 broker를 호출할 때 HS256 JWT를 쓴다. 수명은 120초 이하다.
  - audience마다 비밀키가 따로 있다 (`SANDBOXD_JWT_SECRET`, `BROKER_JWT_SECRET`).
  - claims: `sub`=사용자 id, `sid`=세션 id, `ctx`=전달 헤더와 metadata.
- sandboxd는 요청 본문의 `user`가 토큰의 `sub`와 같은지 확인한다.
- broker admin API는 별도 포트에서 별도 토큰(`BROKER_ADMIN_TOKEN`)으로 받는다.
- 비밀값은 `X_FILE=/run/secrets/x` 형태(Docker secrets)로 읽는다. 없으면 `X` 환경변수를 쓴다.

## 4. 한 턴의 흐름

1. 클라이언트가 `POST /v1/responses`를 보낸다.
2. gateway가 인증하고 principal을 결정한다 (§6).
3. `previous_response_id`로 세션을 찾고 소유자와 stale 여부를 검사한다. 이 과정은 세션 lock 안에서 한다.
4. 동시 실행 제한 slot을 얻는다 (전역, 사용자별).
5. 메모리에 세션이 없으면 JSONL에서 `SessionManager.open()`으로 되살린다.
6. `session.prompt(text)`를 호출한다. pi의 이벤트는 SSE로 변환된다 (§6).
7. 도구 호출은 다음 경로로 실행된다.
   - `read`/`write`/`edit`/`ls`/`find`: pi tool definition의 `operations` → SandboxClient → sandboxd `/v1/fs/*`
   - `bash`: gateway 자체 구현 → sandboxd `/v1/exec` (NDJSON 스트림)
   - `grep`: gateway 자체 구현 → sandboxd `/v1/exec`로 `rg --json` 실행
   - `mcp__<server>__<tool>`: broker 서버는 `POST {BROKER_URL}/mcp/<id>`, sandbox 서버는 sandboxd `/v1/attach` (WebSocket stdio)
   - `AskUserQuestion`: §7
8. `agent_settled` 이벤트에서 턴을 commit한다 (turn 카운터 증가, 응답 객체 생성). 마지막 이벤트로 `response.completed`를 보낸다.

## 5. 세션 수명주기와 메모리

| 대상 | 정책 |
|---|---|
| pi AgentSession | `SESSION_IDLE_SECONDS`(기본 300) 동안 활동이 없으면 정리한다.<br>순서: `await session.abort()` → extensionRunner로 `session_shutdown` 발행 → `dispose()`. 다음 요청에서 JSONL로 되살린다. |
| 세션 기록 | `/data/sessions/<userKey>/<sessionId>.jsonl` (pi SessionManager 파일 형식). sandbox에는 mount하지 않는다. |
| 세션 메타 | SQLite `sessions` 테이블: 소유자, turn 카운터, 대기 중인 AskUserQuestion, 프롬프트 스냅샷, 모델 |
| sandbox 컨테이너 | `SANDBOX_IDLE_SECONDS`(기본 900) 동안 사용이 없으면 제거한다. workspace는 남는다. 다음 도구 호출에서 다시 만든다 (약 0.4초). |
| 동시 실행 | `MAX_CONCURRENT_TURNS`(전역), `MAX_CONCURRENT_TURNS_PER_USER`. 초과분은 FIFO로 기다리다 시간이 지나면 503을 준다. |

개발 머신 측정값 (2026-10-16, WSL2, Docker 29.1.3; 운영에서 다시 잰다):

| 항목 | 측정값 |
|---|---|
| gateway 기본 RSS | 약 135MB |
| pi 세션 | 빈 세션 약 0.04MB, 대화 기록 120KB 세션 약 0.1MB, 1MB 세션 약 1.1MB |
| 유휴 sandbox 컨테이너 | 약 13~15MB (shim 약 11MB 포함) |
| 시간 | 명령 1회 약 67ms, 컨테이너 생성 약 0.4초 |
| 비교: `oh-my-gateway` | 세션당 약 400MB |

### pi SDK 사용 규칙

1.2.0 소스를 읽고 확인한 함정들이다. 버전을 올릴 때 다시 확인한다.

**설정**
- 기본 설정을 쓰면 project trust가 켜지고 `~/.pi`, `<cwd>/.pi/extensions`, `AGENTS.md`/`CLAUDE.md`를 읽거나 실행한다. 다음처럼 만든다.
  - `ResourceLoader`: 직접 구현해서 디스크를 탐색하지 않게 한다.
  - `SettingsManager.inMemory({cacheWarming: "off", enableInstallTelemetry: false, compaction: {enabled: true}}, {projectTrusted: false})`
  - `ModelRuntime`: 하나를 모든 세션이 공유한다. `InMemoryCredentialStore`와 `modelsPath: null`로 만든다.
- 환경변수 `PI_OFFLINE=1`을 켠다.
- 설정 값 안의 `!cmd`는 gateway에서 `execSync`로 실행되고, `$VAR`는 gateway의 env로 치환된다. 테넌트 입력이 apiKey, headers, MCP env에 절대 들어가면 안 된다.

**도구**
- 내장 `grep`은 `operations`를 줘도 gateway에서 ripgrep을 실행한다. 직접 구현한다.
- 내장 `bash`는 gateway의 `process.env` 전체를 넘기고, 긴 출력은 gateway의 `/tmp`에 쓴다. 직접 구현한다.
  스키마와 설명은 pi 정의를 그대로 쓰고 `execute`만 바꾼다.
- 도구 이름 `read`와 `bash`를 유지한다. 이 이름이 없으면 시스템 프롬프트에 skills 섹션이 빠진다.
- 기본으로 도구가 병렬 실행된다. AskUserQuestion은 `executionMode: "sequential"`로 둔다.
- pi는 도구 결과의 이미지를 gateway 프로세스 안에서 디코딩·리사이즈한다 (read, `_afterToolCall`). 해상도 확인이 없어서, 389KB PNG 하나가 4GB 넘게 메모리를 쓸 수 있다.
  - read와 MCP 결과의 이미지는 pi에 넘기기 전에 헤더로 해상도를 확인한다. 25MP·20MB를 넘거나 헤더를 읽을 수 없으면 텍스트 안내로 바꾼다 (`src/tools/image-guard.ts`).
- pi의 read/write/edit은 operations와 별개로 agent 경로를 gateway 로컬에서 확인한다 (read는 파일 이름 변형을 `access`로 찾고, write/edit은 queue 키를 `realpath`로 만든다).
  - 그래서 pi에는 세션별 이름공간 경로 `/.pi-sbx/<key>/<sandbox 경로>`만 보여준다. operations와 결과 텍스트에서 접두사를 뗀다 (`PathNamespace`, `src/tools/remote-fs.ts`).
  - 이렇게 하면 로컬 파일 존재 여부가 새지 않고, 세션 사이에 queue를 공유하지도 않는다.

**세션과 이벤트**
- `dispose()`는 `session_shutdown`을 보내지 않는다. 위 순서대로 정리한다.
- 이벤트 리스너는 동기로 호출된다. 반드시 try/catch로 감싼다.
- 한 번의 prompt에서 끝을 알리는 이벤트는 `agent_settled` 하나뿐이다.

## 6. `/v1/responses` 계약

`oh-my-gateway`와 호환한다. 기준 문서는 `oh-my-gateway/docs/streaming-events.md`와 `src/routes/responses.py`다.

### 요청

| 필드 | 처리 |
|---|---|
| `model` | `LLM_MODELS`에 정의된 id. 없는 모델이면 400. |
| `input` | 문자열이거나 `{role, content}` 메시지 배열이다. 배열이면 `User: `/`Assistant: ` 라벨을 붙여 한 프롬프트로 합친다. `{type:"function_call_output", call_id, output}`(문자열)도 받는다. |
| `instructions` | 첫 턴에만 받는다. `previous_response_id`와 같이 오면 400. 없으면 input의 마지막 system/developer 메시지를 쓴다. |
| `previous_response_id` | 이전 응답 id. 세션을 이어간다. |
| `stream` | SSE 여부 |
| `user` | principal (아래 인증 규칙) |
| `metadata` | 그대로 돌려준다. `MCP_METADATA_KEYS`에 있는 키는 MCP 템플릿에 쓸 수 있다. |
| `reasoning.effort` | pi thinkingLevel로 바꾼다 (모델이 reasoning을 지원할 때만). |
| `temperature`, `max_output_tokens`, `tools`, `tool_choice` 등 | 무시한다. |

### 인증

| 설정 | 동작 |
|---|---|
| `USER_API_KEYS` (`{"alice": "key"}`) | 키가 principal을 정한다. `body.user`는 덮어쓴다. |
| `API_KEY` | 서비스 키다. `body.user`를 믿는다 (BFF 패턴). |
| 둘 다 없음 | `AUTH_DISABLED=1`일 때만 허용한다 (개발용). |

**익명 세션 주의:** 서비스 키로 `user` 없이 시작한 세션은 principal이 `_anon-<sessionId>`예요. 그래서 **응답 id를 아는 서비스 키 사용자라면 누구든 그 세션을 이어갈 수 있어요.** 응답 id가 사실상 세션 열쇠예요.
- 서비스 키는 BFF처럼 신뢰하는 백엔드만 가져야 해요.
- BFF는 응답 id를 자기 사용자에게만 돌려줘야 해요.
- 사용자를 구분할 수 있으면 `user`를 꼭 보내세요. 그러면 다른 `user`로 이어가려는 요청은 404가 돼요.
- 익명 세션은 `ANON_SESSION_TTL_SECONDS`(기본 1시간)가 지나면 기록·sandbox·workspace까지 지워요.

### 응답 id와 세션

- 응답 id는 `resp_{sessionUuid}_{turn}`이다 (turn은 1부터 시작).
- 다른 사용자의 세션이면 404 `Session for previous_response_id '…' not found or expired`.
- 최신 turn보다 오래된 id면 409 `Stale previous_response_id: only the latest response (resp_<sid>_<N>) can be continued`.
- 아직 없는 turn이면 404.
- 턴 commit은 completed, requires_action, 사용자 취소일 때만 한다. 실패한 턴은 commit하지 않는다.

### SSE

프레임은 `event: <type>\ndata: <json>\n\n`이다. `sequence_number`는 응답 전체에서 1씩 증가한다. 15초마다 `: keepalive`를 보낸다.

1. `response.created`, `response.in_progress`
2. 텍스트:
   `response.output_item.added`(message) → `response.content_part.added` → `response.output_text.delta`* → `response.output_text.done` → `response.content_part.done` → `response.output_item.done`
3. reasoning: `response.reasoning_summary_text.delta` (thinking delta)
4. 도구 (사용자 정의 이벤트):
   `response.tool_use_started {tool_use_id, name}` → `response.tool_use {tool_use_id, name, input}` → `response.tool_progress {tool_use_id, name, elapsed_seconds}` → `response.tool_result {tool_use_id, content, is_error}`
5. 종료: `response.completed`, `response.failed {error:{code, message}}`, `response.incomplete`

### 오류 형식

- 기본: `{"error": {"message", "type", "code"}}`
- 용량 초과: 503 `{"error": {"type": "server_overloaded", "code": "concurrency_limit_exceeded", "retry_after": 30}}`
- 그 밖의 형식은 `oh-my-gateway/src/main.py`의 exception handler를 따른다.

### usage

```
{input_tokens, output_tokens, total_tokens,
 input_tokens_details: {cached_tokens, cache_creation_tokens}}
```

pi의 `usage`에서 이렇게 옮긴다.

| Responses 필드 | pi 필드 |
|---|---|
| `input_tokens` | `input + cacheRead + cacheWrite` |
| `cached_tokens` | `cacheRead` |
| `cache_creation_tokens` | `cacheWrite` |

## 7. AskUserQuestion

**도구 스키마** (Claude Code와 같다):

```json
{"questions": [{"question": "…", "header": "…", "multiSelect": false,
                "options": [{"label": "A", "description": "…"}]}]}
```

**모델이 호출했을 때**
- `execute()`가 바로 반환한다. 결과는 `{content: "질문을 사용자에게 보여줬다. 답은 다음 사용자 메시지로 온다.", details: {questions}, terminate: true}`이다.
- 같은 배치에 다른 도구가 섞이면 `terminate`가 적용되지 않는다. 그래서 `session.agent.finishTurn`을 감싸 AskUserQuestion이 있으면 `{action: "end"}`를 돌려준다.

**gateway가 하는 일**
- 세션 메타에 `pending_tool_call = {call_id, name, arguments}`를 저장한다.
- 턴을 commit하고 다음을 보낸다.
  - `response.output_item.added` (`item.type: "function_call"`)
  - `response.completed` (`status: "requires_action"`, `output: [function_call]`)

**클라이언트 응답**
- `{previous_response_id, input: [{type: "function_call_output", call_id, output: "<문자열>"}]}`로 답한다.
- call_id가 다르면 400이다.
- 대기 중에 일반 메시지를 보내면 409다 (`oh-my-gateway`와 같다).
- 답은 `User responded: <output>` 사용자 메시지로 `session.prompt()`에 넣는다.

**장점**
- 기다리는 동안 세션을 메모리에 붙잡지 않는다 (idle 정리 대상이다).
- 재시작해도 이어갈 수 있다.

## 8. MCP

### 서버 설정 스키마

`packages/shared/src/mcp-config.ts`

- `runIn`
  - `broker`: 비밀키가 필요한 서버. broker가 실행하거나 프록시한다. 저장 위치는 broker DB.
  - `sandbox`: 비밀키가 없고 workspace 파일이 필요한 서버. 사용자 컨테이너 안에서 stdio로 실행한다. 저장 위치는 gateway DB.
- `transport`
  - `{type: "stdio", command, args, env, cwd}`
  - `{type: "http", url, headers}`. streamable HTTP이고 SSE 전용 서버는 지원하지 않는다.
- `scope`: 프로세스·연결 공유 단위. `shared`, `per-user`, `per-session` 중 하나다.
- 템플릿 자리표시자 (transport의 문자열 값 안):

| 자리표시자 | 값 | broker | sandbox |
|---|---|---|---|
| `{{secret:NAME}}` | broker 비밀 저장소 값 | ✅ | ❌ 금지 |
| `{{ctx.header:NAME}}` | 클라이언트가 보낸 헤더 (`MCP_FORWARD_HEADERS` allowlist) | ✅ | ❌ 금지 (사용자 토큰이 agent에게 보이므로) |
| `{{user}}` | 사용자 id | ✅ | ✅ |
| `{{session}}` | 세션 id. 쓰면 `per-session`이 강제된다. | ✅ | ✅ |
| `{{metadata:KEY}}` | 요청 metadata (`MCP_METADATA_KEYS` allowlist) | ✅ | ✅ |
| `{{plugin_root}}` | plugin 설치 경로 (설치할 때 치환) | ✅ | ✅ |

### 도구 이름

`mcp__<serverId>__<tool>`. 사용자에게 보이는 것은 `toolAllow`/`toolDeny`로 거른다.

### broker (`apps/mcp-broker`)

- **데이터 평면** (`BROKER_PORT`)
  - `POST /mcp/:serverId`: MCP Streamable HTTP, 프로토콜 2025-11-25, stateless. pi-mcp 클라이언트가 2025-11-25만 지원해서다.
  - `GET /mcp/servers`: 이 사용자가 쓸 수 있는 서버 목록
  - 인증은 `Authorization: Bearer <JWT aud=broker>`다.
- **관리 평면** (`BROKER_ADMIN_PORT`, `BROKER_ADMIN_TOKEN`)
  - 서버 CRUD, 비밀키 쓰기 전용 PUT/DELETE, 연결 테스트, 도구 목록, 감사 로그
  - 비밀값은 어떤 API로도 다시 읽을 수 없다. 이름, 설정 시각, fingerprint만 돌려준다.
- **비밀 저장**
  - SQLite에 AES-256-GCM으로 암호화해 저장한다. AAD는 `serverId|name|version`이다.
  - KEK는 Docker secret 파일로 받는다.
- **stdio upstream**
  - 이미지에 미리 설치한 명령만 실행한다. 런타임에 `npx`로 내려받지 않는다.
  - env는 해당 서버의 값만 준다. `process.env`를 물려주지 않는다.
  - 가능하면 별도 uid로 실행한다 (`setpriv`, 컨테이너에 SETUID/SETGID cap 필요).
  - 프로세스 풀의 key는 `(serverId, scopeKey)`이고, 유휴 TTL과 최대 개수 제한을 둔다.
- **결과 필터**: 범위 안의 비밀값(원문, base64, URL 인코딩)을 결과와 오류 메시지에서 `[REDACTED]`로 바꾼다. upstream 오류는 상관 id만 붙인 일반 메시지로 바꾼다.

### sandbox 실행 MCP

gateway가 sandboxd `/v1/attach`(WebSocket)로 사용자 컨테이너 안에 stdio 프로세스를 띄운다. pi-mcp `McpClient`는 이 위에 커스텀 `McpTransport`로 연결한다.

- 프로세스 단위: `per-session`(기본) 또는 `per-user`
- 유휴 시 종료하고, 컨테이너가 멈추면 같이 정리된다.
- 예: `monsemi-frontend`. `THREAD_ID`는 `{{metadata:THREAD_ID}}`, `ORCHESTRATOR_URL`은 `{{metadata:ORCHESTRATOR_URL}}`이다.
  - 기존 클라이언트(a2a-agent)가 metadata에 대문자 키로 보내는 값이다 (`oh-my-gateway`의 `METADATA_ENV_ALLOWLIST=THREAD_ID,ORCHESTRATOR_URL`와 같다).
  - `SERVICE_URL`은 관리자가 고정값으로 덮어쓸 수 있다.

### 관리 화면 흐름

- gateway 관리 UI가 두 저장소를 합쳐서 보여준다. broker 서버는 broker admin API로, sandbox 서버는 gateway DB에서 가져온다.
- 비밀값은 브라우저 → gateway(메모리 통과만) → broker로 간다. gateway는 저장하지 않는다.

## 9. plugin

### 설치 흐름

1. `POST /admin/api/marketplaces {url, ref?, token?}`
   - `git clone --depth 1 -c core.symlinks=false`로 gateway의 `DATA_DIR` 아래에 받는다. sandbox에는 보이지 않는 위치다.
   - token은 askpass로만 넘기고 저장하지 않는다.
   - `.claude-plugin/marketplace.json`을 파싱한다. 저장소 안의 파일은 모두 경계 검사를 거쳐 읽는다 (`readContainedFile`).
2. `POST /admin/api/plugins/install {marketplace, plugin}`
   - source 종류: relative, `url`, `git-subdir`, `github`. 버전은 SHA로 고정한다.
   - `/opt/plugins/<marketplace>/<plugin>/<version>`에 복사한다.
   - `<plugin>/current` → `<version>` symlink를 원자적으로 바꾼다 (임시 symlink를 만든 뒤 rename).
   - 기록, skill 경로, MCP args/env, `${CLAUDE_PLUGIN_ROOT}` 치환은 모두 `.../current/...`를 쓴다.
     - 업데이트해도 broker가 보는 실행 대상이 그대로라 저장된 비밀키가 유지된다.
   - 현재 버전과 바로 이전 버전만 남긴다.
   - 이 경로는 gateway, sandbox, broker에서 같다.
3. 바뀐 내용은 새 세션부터 적용된다.
   - 예외: 진행 중인 세션도 `current`를 거쳐 새 버전 파일을 읽는다.
   - 시스템 프롬프트의 skill 목록은 세션을 만들 때 고정된다. 그래서 새 버전에서 없어진 skill을 읽으면 그 세션은 ENOENT를 받는다.

### 컴포넌트 대응

| Claude 구성요소 | pi 대응 | v1 |
|---|---|---|
| `skills/*/SKILL.md` | pi Skill (같은 Agent Skills 형식). 이름 충돌을 막으려고 plugin 이름을 앞에 붙인다. `filePath`는 `/opt/plugins/...` | ✅ |
| `commands/*.md` | pi PromptTemplate (`<plugin>:<cmd>`). `$N`은 0-based에서 1-based로 바꾼다. | ✅ |
| `.mcp.json` | MCP 서버로 등록한다. 비밀키 자리표시자가 없으면 `runIn: sandbox`, 있으면 `broker`(관리자가 키를 입력해야 활성화). | ✅ |
| hooks, agents, LSP, monitors, workflows, output-styles, `bin/` | "지원 안 됨"으로 기록하고 UI에 표시한다. | ❌ |

참고: `acolomba/pi-claude-marketplace` (MIT)의 호환성 표.

## 10. 시스템 프롬프트

- **SQLite 테이블**: `prompts`, `prompt_versions`(append-only, sha), `prompt_deployments`(이력), `prompt_live`(현재 배포본, revision CAS)
- **템플릿 변수**: `{{USER}}`, `{{DATE}}`, `{{DATETIME}}`, `{{WORKSPACE}}`(=`/workspace`), `{{MODEL}}`, `{{LANGUAGE}}`(`PROMPT_LANGUAGE`)
- **적용 시점**
  - 세션을 만들 때 렌더링해서 세션 메타에 스냅샷으로 저장한다. 되살릴 때도 같은 프롬프트를 써서 prompt caching이 안정적이다.
  - 새로 배포한 프롬프트는 새 세션부터 적용된다.
- **pi에 넣는 방법**: `ResourceLoader.getSystemPrompt()`로 넣는다.
  - 이 값은 pi 기본 preamble을 대체한다. 도구 목록은 API의 tools 파라미터로 따로 간다.
  - pi는 skills 섹션과 `<cwd>`를 뒤에 덧붙인다.
  - 배포된 프롬프트가 없으면 `apps/gateway`에 포함된 기본 프롬프트를 쓴다.
- **요청별 추가**: 첫 턴의 `instructions`와 `Current user: <user>`를 뒤에 붙인다.

## 11. 관리 화면

- `/admin`에서 서빙한다. Vite + Preact로 빌드하고 gateway가 정적 파일로 제공한다.
- **로그인**: `ADMIN_API_KEY`로 로그인하면 HttpOnly·SameSite=Strict 서명 쿠키를 준다. 상태를 바꾸는 요청에는 `X-Admin-Request: 1` 헤더를 요구한다 (CSRF 방어).
- **화면**

| 화면 | 기능 |
|---|---|
| 프롬프트 | 목록, 편집(새 버전), diff, 미리보기(렌더링 결과), 배포, 롤백, 이력 |
| MCP | 목록(broker와 sandbox), 추가·수정, 비밀키 입력(쓰기 전용), 연결 테스트, 도구 목록 |
| plugin | marketplace 추가·새로고침, 목록 탐색, 설치·제거, 컴포넌트별 지원 여부 |
| 상태 | 활성 세션 수, 활성 sandbox 수, 메모리 |

## 12. 설정 (주요 환경변수)

설정 정의의 기준은 `apps/gateway/src/config.ts`이고, 예시는 `.env.example`에 있다.

| 영역 | 변수 |
|---|---|
| LLM | `LLM_API`(`openai-completions` \| `anthropic-messages`), `LLM_BASE_URL`, `LLM_API_KEY[_FILE]`, `LLM_MODELS`(JSON: `[{id, name?, contextWindow, maxTokens, reasoning?, input?}]`), `DEFAULT_MODEL` |
| 인증 | `API_KEY[_FILE]`, `USER_API_KEYS[_FILE]`, `ADMIN_API_KEY[_FILE]`, `AUTH_DISABLED` |
| 내부 통신 | `SANDBOXD_URL`, `SANDBOXD_JWT_SECRET[_FILE]`, `BROKER_URL`, `BROKER_ADMIN_URL`, `BROKER_JWT_SECRET[_FILE]`, `BROKER_ADMIN_TOKEN[_FILE]` |
| 세션 | `DATA_DIR`(`/data`), `SESSION_IDLE_SECONDS`, `MAX_CONCURRENT_TURNS`, `MAX_CONCURRENT_TURNS_PER_USER`, `TURN_QUEUE_TIMEOUT_SECONDS` |
| MCP | `MCP_FORWARD_HEADERS`(전달할 헤더 allowlist), `MCP_METADATA_KEYS` |
| plugin | `PLUGINS_DIR`(`/opt/plugins`) |
| sandboxd | `SANDBOX_IMAGE`, `SANDBOX_EGRESS_ALLOW`, `SANDBOX_PROXY_DENY`, `WORKSPACES_HOST_DIR`, `PLUGINS_HOST_DIR`, `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_PIDS_LIMIT`, `SANDBOX_TMP_SIZE`, `SANDBOX_IDLE_SECONDS`, `SANDBOX_RUNTIME`(`runc` \| `runsc`) |

## 13. 배포

docker compose를 쓴다.

**서비스**
- `gateway`: 포트 공개. edge와 control 네트워크.
- `sandboxd`: `/var/run/docker.sock` mount. control 네트워크.
- `mcp-broker`: control과 broker-egress 네트워크. 포트 비공개.
- `egress-proxy`: sandbox의 유일한 바깥 경로 (Smokescreen). unix socket(`proxy-sock` 볼륨)에서만 듣고, proxy-egress 네트워크로 나간다.

**네트워크**

| 네트워크 | 붙는 것 |
|---|---|
| `edge` | gateway |
| `control` (internal) | gateway, sandboxd, broker |
| `broker-egress` | broker의 외부 접근 |
| `proxy-egress` | egress-proxy의 외부 접근 |

**호스트 디렉토리**

| 디렉토리 | mount |
|---|---|
| `${PI_GATEWAY_HOME}/workspaces` | sandboxd에서 rw (사용자 디렉토리 생성), sandbox마다 자기 디렉토리만 rw |
| `${PI_GATEWAY_HOME}/plugins` | gateway rw, broker ro, sandbox ro. 모두 `/opt/plugins`에 mount |

- **볼륨**: `gateway-data` (sessions, gateway.db), `broker-data` (broker.db)
- **secrets**: `sandboxd_jwt_secret`, `broker_jwt_secret`, `broker_admin_token`, `broker_kek`, `llm_api_key`, `admin_api_key`, `user_api_keys`
- **이미지**: 루트 `Dockerfile`을 multi-stage로 쓴다 (target: gateway, sandboxd, mcp-broker). sandbox 이미지는 `images/sandbox/Dockerfile`이다.

## 14. 검증

- **단위 테스트**: vitest. `npm test`
- **통합 테스트**: Docker가 필요하다. `PI_GW_DOCKER_TESTS=1`일 때만 돈다. 실제 sandboxd와 sandbox 컨테이너를 쓴다.
- **E2E**: 가짜 OpenAI 호환 LLM 서버(`apps/gateway/test/fake-llm`)가 정해진 tool call을 내보내고, 전체 흐름과 SSE 계약을 검증한다.
- **보안 검증** (`scripts/security-check`): sandbox 안에서 실제로 다음을 시도하고 결과를 리포트로 낸다.
  - 다른 사용자 workspace, `/proc/1/environ`, `/etc`, env의 비밀값
  - 내부 서비스 접속, docker.sock 존재 여부
  - metadata 주소 접속, 권한 상승
  - 각 차단 테스트에는 "격리가 없으면 새는 것"을 보여주는 대조군을 둔다.
- **메모리 측정**: `scripts/bench`. 운영 서버에서 다시 잰다.

## 15. 도구 확장

새 도구는 아래 다섯 경로 중 하나로 추가한다. 앞의 세 경로는 코드 수정 없이 관리 화면에서 끝난다. 절차는 `docs/EXTENDING.md`에 있다.

| 추가하려는 것 | 방법 | 코드 수정·재배포 |
|---|---|---|
| 외부 API·사내 시스템 도구 (인증키 필요) | broker MCP 서버 등록 | 불필요 |
| workspace 파일을 다루는 도구 (키 불필요) | sandbox MCP 서버 등록 | 불필요 |
| 작업 절차와 스크립트 묶음 | plugin skill 설치 | 불필요 |
| agent가 쓰는 CLI 프로그램 | sandbox 이미지 빌드 인자 `SANDBOX_EXTRA_APT_PACKAGES`/`_PIP_`/`_NPM_`, 또는 파생 이미지 | 이미지 재빌드 |
| gateway와 깊게 연동되는 도구 (응답 흐름이 바뀌는 것) | `ToolProvider` 모듈 추가 (`apps/gateway/src/tools/providers/`) | gateway 재배포 |

**gateway 도구 구조**
- 모든 도구는 `ToolProvider`(`src/tools/provider.ts`)가 세션마다 만들어 준다.
  - 현재 provider: `sandbox`(read/write/edit/ls/find/bash/grep), `ask-user`(AskUserQuestion), `mcp-broker`, `mcp-sandbox`
- `src/tools/registry.ts`가 provider들을 모아 `ToolPolicy`(관리 화면의 켜기/끄기)로 거른 뒤 pi `customTools`에 넣는다.
- 관리 화면의 "도구" 페이지에서 전체 목록, 실행 위치, 켜기/끄기를 관리한다. `read`처럼 끌 수 없는 도구는 `required`다.

**배치 규칙 (보안)**
- 사용자 입력에 따라 코드를 실행하거나 파일을 다루는 도구는 반드시 sandbox를 거친다.
- 비밀키가 필요한 도구는 broker(MCP)를 거친다. gateway env에 키를 두지 않는다.
- gateway 안에서 직접 실행하는 도구는 AskUserQuestion 같은 흐름 제어용으로만 쓴다.
