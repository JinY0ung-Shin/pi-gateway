# pi-gateway

[pi](https://github.com/earendil-works/pi) 기반 agent gateway. OpenAI Responses 호환 `POST /v1/responses`를 제공한다.
세션은 한 Node 프로세스 안의 pi 객체이고, agent의 도구 실행은 사용자별 sandbox 컨테이너에서만 일어난다.

## 구조

```
client ─▶ gateway ─┬─▶ sandboxd ──▶ sbx-<user>   (사용자별 컨테이너, 네트워크 없음)
                   │                    └─▶ egress-proxy ─▶ 허용 목록의 도메인·IP (HTTP/HTTPS만)
                   └─▶ mcp-broker ─▶ 키가 필요한 MCP 서버
```

코드는 `apps/gateway`, `apps/sandboxd`, `apps/mcp-broker`, `images/egress-proxy`에 있다. 서비스마다 하는 일·네트워크·가진 비밀은 [OPERATIONS.md §1](docs/OPERATIONS.md#1-구성)에 있다.

## 보안 경계

- **agent loop와 도구 실행을 분리한다.** agent loop는 gateway에서 돌고, `read`·`write`·`edit`·`ls`·`find`·`bash`·`grep`과 sandbox MCP는 사용자 컨테이너에서 돈다.
- **sandbox 컨테이너에는 비밀이 없다.**
  - mount는 본인 workspace(`/workspace`), plugin(`/opt/plugins`, 읽기 전용), egress 프록시 socket(`/run/pi-proxy`, 읽기 전용) 세 개뿐이다.
  - 읽기 전용 rootfs, capability 없음, 네트워크 없음이다.
- **MCP 키는 broker에만 있다.** 암호화해 저장하고, 관리 API로는 쓸 수만 있다. 접속 대상이 바뀌면 키가 지워진다.
- **확인 방법:** `scripts/security-check`가 이 경계를 실제로 시험한다.

## `/v1/responses`

- **응답 id와 이어가기:** id는 `resp_{session}_{turn}`이다. `previous_response_id`로 이어간다.
  - 다른 사용자의 세션이거나 아직 없는 turn이면 404다.
  - 예전 응답 id를 주면 그 지점에서 갈라진다 (메시지 수정·재생성). 새 응답은 다음 turn 번호를 받고, 갈라진 쪽들 모두 계속 이어갈 수 있다.
  - 되돌아가는 것은 대화 기록뿐이다. workspace 파일과 MCP로 한 일은 그대로다.
  - 이어가는 턴에서도 `model`과 `reasoning.effort`를 바꿀 수 있다. 대화 기록과 도구는 그대로이고 그 턴부터 새 설정으로 돈다 (유휴 뒤 다시 열어도 마찬가지다). 설정하지 않은 모델이면 400이다. 빼면 세션의 설정을 그대로 쓰고, `model`만 바꾸고 effort를 빼면 새 모델의 기본 effort를 쓴다. 기본 모델로 바꾸려면 그 id(`/v1/models`의 `default: true`)를 보낸다.
- **인증:**
  - `USER_API_KEYS`(키가 사용자를 정함) 또는 `API_KEY`(`user` 필드를 믿음)를 쓴다.
  - 사용자 없는 요청은 400이다.
- **취소:** `POST /v1/responses/{id}/cancel`(서비스 키면 `?user=`)은 진행 중인 턴을 멈춘다.
  - 스트림은 `response.incomplete`(`user_cancelled`)로 끝나고, 그 id로 다음 턴을 이어갈 수 있다.
  - 이미 끝난 응답이면 409 `response_not_cancellable`, 다른 사용자의 응답이거나 없는 응답이면 404다.
- **도구 호출 상한:** 한 턴에서 모델이 도구를 200번 넘게 부르면 턴을 멈추고 `incomplete`(`max_tool_calls`)로 끝낸다. 그때까지의 내용은 남고 그 id로 이어갈 수 있다. 하위 agent도 같은 상한을 넘으면 Agent 도구가 오류를 돌려준다.
- **모델 목록:** `GET /v1/models`는 관리 화면 LLM 페이지에 설정한 모든 서버의 모델을 돌려준다 (`owned_by`는 서버 id, `default`는 `model`을 주지 않은 새 세션이 쓰는 모델인지). LLM을 설정하기 전에는 `/v1/responses`가 503 `llm_not_configured`다.
- **관리 화면 채팅 테스트:** `/admin`의 "채팅 테스트"는 관리자 로그인으로 `/v1/responses`와 같은 처리를 한다 (`POST /admin/api/chat`, 중지는 `POST /admin/api/chat/{id}/cancel?user=`). 입력한 user의 workspace·MCP·skill로 실행된다.
- **이미지 입력:** `input_image`는 base64 `data:` URL만 받는다 (25MP·20MB 제한). LLM 설정에서 이미지를 켜지 않은 모델이면 400이다.
- **SSE 이벤트:**
  - 텍스트: `response.created` → `output_item.added` / `output_text.delta`… → `response.completed` | `failed` | `incomplete`
  - 도구: `response.tool_use_started` / `tool_use` / `tool_progress` / `tool_result`
- **AskUserQuestion:**
  - 질문이 오면 `status: "requires_action"`과 `function_call` 항목을 보낸다.
  - 답은 `function_call_output`으로 받는다.
  - call_id가 다르면 400이다. 대기 중에 일반 메시지가 오면 409다.
- **interactive:** 사용자가 답할 수 없는 요청이면 `interactive: false`를 준다 (기본 `true`). 그 세션(하위 agent 포함)에서 사용자에게 묻는 도구(지금은 `AskUserQuestion`)를 뺀다.
  - 세션을 만들 때 정해진다. 이어가는 턴에 같은 값을 다시 보내는 것은 되고, 다른 값이면 400이다.
- **read_only:** 남이 쓴 내용이 이 사용자의 sandbox를 움직이는 요청이면 `read_only: true`를 준다 (기본 `false`). 그 세션(하위 agent 포함)에서 sandbox를 바꾸거나 명령을 실행하는 도구(`write`, `edit`, `bash`, sandbox에서 도는 MCP 서버)를 뺀다. `read`, `ls`, `find`, `grep`, `present_file`과 broker MCP 서버는 남는다.
  - 세션을 만들 때 정해진다. 이어가는 턴에 같은 값을 다시 보내는 것은 되고, 다른 값이면 400이다.
- **구조화된 출력:** `text.format`에 `json_schema`(최상위 `type: "object"`)를 주면 최종 답이 그 스키마의 JSON이 된다.
  - 결과는 `structured_output`에 객체로, `output_text`에 JSON 문자열로 나간다. 모델이 끝까지 답을 내지 않으면 `structured_output_missing`으로 실패한다.
  - 스키마는 세션을 만들 때 정해진다. 이어가는 턴에 같은 스키마를 다시 보내는 것은 되고, 다른 스키마면 400이다.
- **파일 보여주기:**
  - 에이전트가 `present_file`을 부르면 스트림 도중에 `type: "file"` 출력 항목(`path`, `filename`, `mime_type`, `size`)이 나간다. 최종 `output`에도 남는다.
  - 내용은 `GET /v1/files/content?path=`(서비스 키면 `&user=`)로 받는다. `/workspace` 아래 파일만 되고 최대 32MiB다.
  - 렌더링은 클라이언트가 `mime_type`을 보고 한다. 응답은 `attachment`와 `Content-Security-Policy: sandbox`로 나가므로, HTML은 받아서 sandbox iframe 등에 띄운다.

## 개발

```bash
npm install
npm run typecheck && npx vitest run   # 타입 검사(관리 화면·테스트 포함)와 테스트
PI_GW_DOCKER_TESTS=1 npx vitest run   # Docker가 필요한 테스트 포함
```

- 배포와 운영: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- 도구·MCP·plugin 추가: [docs/EXTENDING.md](docs/EXTENDING.md)
- 작업 원칙: [CLAUDE.md](CLAUDE.md)
