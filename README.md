# pi-gateway

[pi](https://github.com/earendil-works/pi) 기반 agent gateway. OpenAI Responses 호환 `POST /v1/responses`를 제공한다.
세션은 한 Node 프로세스 안의 pi 객체이고, agent의 도구 실행은 사용자별 sandbox 컨테이너에서만 일어난다.

## 구조

```
client ─▶ gateway ─┬─▶ sandboxd ──▶ sbx-<user>   (사용자별 컨테이너, 네트워크 없음)
                   │                    └─▶ egress-proxy ─▶ 허용 목록의 도메인·IP (HTTP/HTTPS만)
                   └─▶ mcp-broker ─▶ 키가 필요한 MCP 서버
```

| 서비스 | 하는 일 | 가진 비밀 |
|---|---|---|
| `gateway` (`apps/gateway`) | API, 인증, 세션, pi agent loop, plugin 설치, 프롬프트, 관리 화면(`/admin`) | LLM 키, 내부 JWT 키 |
| `sandboxd` (`apps/sandboxd`) | 사용자 컨테이너 생성·명령 실행·파일 조작 | docker.sock |
| `mcp-broker` (`apps/mcp-broker`) | MCP 비밀키 보관, MCP 프록시 | MCP 키 |
| `egress-proxy` (`images/egress-proxy`) | sandbox의 유일한 바깥 경로. 허용 목록의 도메인·IP만 연다 | 없음 |

## 보안 경계

- **agent loop와 도구 실행을 분리한다.** agent loop는 gateway에서 돌고, `read`·`write`·`edit`·`ls`·`find`·`bash`·`grep`과 sandbox MCP는 사용자 컨테이너에서 돈다.
- **sandbox 컨테이너에는 비밀이 없다.**
  - mount는 본인 workspace(`/workspace`)와 plugin(`/opt/plugins`, 읽기 전용) 두 개뿐이다.
  - 읽기 전용 rootfs, capability 없음, 네트워크 없음이다.
- **MCP 키는 broker에만 있다.** 암호화해 저장하고, 관리 API로는 쓸 수만 있다. 접속 대상이 바뀌면 키가 지워진다.
- **확인 방법:** `scripts/security-check`가 이 경계를 실제로 시험한다.

## `/v1/responses`

- **응답 id와 이어가기:** id는 `resp_{session}_{turn}`이다. `previous_response_id`로 이어간다.
  - 다른 사용자의 세션이거나 아직 없는 turn이면 404다.
  - 최신이 아닌 id면 409다.
- **인증:**
  - `USER_API_KEYS`(키가 사용자를 정함) 또는 `API_KEY`(`user` 필드를 믿음)를 쓴다.
  - 사용자 없는 요청은 400이다.
- **SSE 이벤트:**
  - 텍스트: `response.created` → `output_item.added` / `output_text.delta`… → `response.completed` | `failed` | `incomplete`
  - 도구: `response.tool_use_started` / `tool_use` / `tool_progress` / `tool_result`
- **AskUserQuestion:**
  - 질문이 오면 `status: "requires_action"`과 `function_call` 항목을 보낸다.
  - 답은 `function_call_output`으로 받는다.
  - call_id가 다르면 400이다. 대기 중에 일반 메시지가 오면 409다.

## 개발

```bash
npm install
npx tsc -b && npx vitest run          # 타입 검사와 테스트
PI_GW_DOCKER_TESTS=1 npx vitest run   # Docker가 필요한 테스트 포함
```

- 배포와 운영: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- 도구·MCP·plugin 추가: [docs/EXTENDING.md](docs/EXTENDING.md)
- 작업 원칙: [CLAUDE.md](CLAUDE.md)
