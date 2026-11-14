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
- **sandbox 컨테이너에는 비밀이 없다.** 예외는 클라이언트가 서비스 키로 보낸 `sandbox_env` 하나다 (아래 `/v1/responses` 절). 그 턴의 `bash` 프로세스 env로만 넘어가고, gateway는 그 값을 컨테이너 설정·gateway DB·세션 기록에 쓰지 않는다.
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
- **턴 도중 입력:** `POST /v1/responses/{id}/input`(서비스 키면 `?user=`), body `{client_id, text}`는 진행 중인 턴에 사용자 메시지를 넣는다. 응답은 `{id, object: "response.input", client_id, status: "queued"}`다.
  - pi가 다음 도구 호출 경계(다음 LLM 호출 전)에 모델에 넣고, 그때 스트림에 `response.input_consumed {client_id}`가 나간다. 여러 개면 넣은 순서대로 들어간다. 마지막 답을 쓰는 중에 온 입력도 그 답 뒤에 같은 턴에서 들어간다.
  - 턴이 끝날 때까지 들어가지 못한 입력(AskUserQuestion·StructuredOutput·취소·도구 호출 상한·실패로 끝난 턴, 또는 턴이 끝나는 순간에 온 입력)은 최종 응답의 `undelivered_input: [client_id…]`에 실리고 버려진다. 다음 턴으로 넘어가지 않으므로 클라이언트가 다시 보낸다. 없으면 필드가 없다.
  - 이미 끝났거나 AskUserQuestion·StructuredOutput을 불러 끝나는 중인 응답이면 409 `response_not_running`, 다른 사용자의 응답이거나 없는(아직 시작 전인) 응답이면 404다.
- **대화 요약:** `POST /v1/responses/{id}/compact`(서비스 키면 `?user=`), body `{instructions?}`는 그 응답까지의 대화 앞부분을 지금 요약한다 (pi의 수동 compaction). `instructions`는 요약에 꼭 남길 내용이다.
  - 답은 SSE다: `response.compaction`이 `status: "in_progress"`로 시작해 `"completed"`(`id`, `tokens_before`, `tokens_after`, `context_window`) 또는 `"failed"`(`error: {code, message}`)로 끝난다.
  - 요약이 새 turn으로 남으므로 다음 턴은 돌려받은 `id`로 이어간다. 원래 `{id}`로 이어가면 요약 전 기록에서 갈라진다.
  - 최근 대화(큰 모델은 20000 token, 작은 모델은 context의 1/4)는 요약하지 않고 그대로 둔다. 대화가 그보다 짧거나 이미 요약한 직후면 `failed`(`nothing_to_compact`)다.
  - 스트림 전에 거절하는 경우: 세션에 진행 중인 응답이 있으면 409 `response_in_progress`, AskUserQuestion 답을 기다리는 응답이면 409, 다른 사용자의 응답이거나 없는 응답이면 404다.
  - 요약에 실패하거나 요청 연결이 끊기면 세션은 그대로다.
- **실행 시간:** `GET /v1/responses/{id}/traces`(서비스 키면 `?user=`)는 그 응답이 속한 세션의 턴별 trace를 최근 턴부터 준다. 답은 `{traces: [{traceId, turn, startedAt, durationMs, spans: [{id, parentId?, service, name, startMs, durationMs, error, attributes}]}]}`이고 관리 화면의 "실행 시간 보기"와 같은 내용이다.
  - 턴이 끝나야 그 턴의 trace가 나온다. 최근 50턴까지이고, 7일이 지난 턴은 없다 (없으면 빈 목록).
  - span에는 이름·시간·token 수·오류 종류만 있다. 프롬프트, 도구 인자·결과, 오류 메시지는 들어가지 않는다.
  - 다른 사용자의 응답이거나 없는 응답이면 404, trace를 켜지 않은 gateway면 404 `tracing_disabled`, Jaeger에 닿지 못하면 503 `trace_store_unavailable`, Jaeger가 오류를 답하면 502 `trace_store_error`다.
- **도구 호출 상한:** 한 턴에서 모델이 도구를 상한(기본 200)보다 많이 부르면 턴을 멈추고 `incomplete`(`max_tool_calls`)로 끝낸다. 그때까지의 내용은 남고 그 id로 이어갈 수 있다. 하위 agent도 같은 상한을 넘으면 Agent 도구가 오류를 돌려준다. 상한은 관리 화면의 기본 도구 페이지에서 바꾸고(1–10000) 다음 턴부터 적용된다.
- **모델 목록:** `GET /v1/models`는 관리 화면 LLM 페이지에 설정한 모든 서버의 모델을 돌려준다 (`owned_by`는 서버 id, `default`는 `model`을 주지 않은 새 세션이 쓰는 모델인지). 관리자가 티어(`eagle`·`falcon`·`swift`)를 설정하면 그 이름이 앞에 붙는다. 기본 모델도 티어일 수 있다. 티어로 연 세션은 티어가 가리키는 모델이 바뀌면 다음 턴부터 새 모델로 돈다. effort를 고른 적 없으면 새 모델의 기본 effort를, 고른 effort를 새 모델이 받지 않으면 그 모델의 기본 effort를 쓴다. LLM을 설정하기 전에는 `/v1/responses`가 503 `llm_not_configured`다.
  - `input`은 받는 입력(`["text"]` 또는 `["text", "image"]`)이다. `image`가 없는 모델에 `input_image`를 보내면 400 `unsupported_image_input`이다.
  - `reasoning`은 reasoning 모델이면 `{efforts, default_effort}`(받는 `reasoning.effort`와 effort를 뺐을 때 쓰는 값), 아니면 `null`(effort는 무시한다)이다. `efforts`에 없는 effort를 보내면 400 `unsupported_reasoning_effort`다.
- **관리 화면 채팅 테스트:** `/admin`의 "채팅 테스트"는 관리자 로그인으로 `/v1/responses`와 같은 처리를 한다 (`POST /admin/api/chat`, 중지는 `POST /admin/api/chat/{id}/cancel?user=`). 입력한 user의 workspace·MCP·skill로 실행된다.
- **이미지 입력:** `input_image`는 base64 `data:` URL만 받는다 (25MP·20MB 제한). LLM 설정에서 이미지를 켜지 않은 모델이면 400이다.
- **문서 입력:** `input_file`은 `filename`과 base64 `data:` URL인 `file_data`만 받는다 (`file_id`·`file_url`은 400 `invalid_file_input`). 요청 본문 전체가 16MiB까지다.
  - 사용자 workspace의 `/workspace/uploads/<filename>`에 쓰고 모델에는 그 경로를 알린다. 내용은 에이전트가 도구로 읽는다. 같은 이름은 덮어쓴다.
  - `filename`은 경로가 아닌 파일 이름이어야 하고, 확장자는 문서 `pdf`·`docx`·`xlsx`·`pptx`·`csv`·`txt`·`md`·`json`과 이미지 `png`·`jpg`·`jpeg`·`gif`·`webp`·`bmp`만 받는다 (대소문자 무시). `read_only` 세션에서는 400이다 (workspace를 바꾸므로).
- **MCP 결과의 파일:** MCP 도구가 바이너리 `resource` 블록을 돌려주면 사용자 workspace의 `/workspace/artifacts/<세션 id>/`에 저장하고 모델에는 경로·크기·sha256을 알린다. `read_only` 세션에서는 저장하지 않는다. 형식과 한도는 [EXTENDING.md](docs/EXTENDING.md#파일을-돌려주는-도구)에 있다.
- **MCP 도구에 보내는 파일:** MCP 도구가 인자에 `"x-workspace-file": true`를 붙이면 모델은 `/workspace` 아래 파일의 경로만 쓰고, gateway가 그 파일을 읽어 이름·크기·sha256과 함께 채워 보낸다. `read_only` 세션에서는 보내지 않는다. 형식과 한도는 [EXTENDING.md](docs/EXTENDING.md#파일을-받는-도구)에 있다.
- **SSE 이벤트:**
  - 텍스트: `response.created` → `output_item.added` / `output_text.delta`… → `response.completed` | `failed` | `incomplete`
  - 도구: `response.tool_use_started` / `tool_use` / `tool_progress` / `tool_result`
  - 하위 agent(`Agent`·`SendMessage`)가 부른 도구도 같은 도구 이벤트로 나간다. 각 이벤트에 `parent_tool_use_id`(부른 `Agent`·`SendMessage` 호출의 `tool_use_id`)가 붙는다. 하위 agent의 텍스트는 나가지 않고, 최종 답은 부모 호출의 `tool_result`로 온다.
  - 자동 대화 요약: context가 차서 pi가 앞 대화를 요약하면 `response.compaction`이 `status: "in_progress"`로 시작해 `"completed"` | `"failed"`로 끝난다.
  - 턴 도중 입력: `response.input_consumed`
- **usage:** `input_tokens`(캐시 읽기·쓰기 포함), `output_tokens`, `input_tokens_details.context_tokens`(마지막 호출 뒤의 context 크기: 그 호출의 입력과 출력. pi가 자동 요약을 판단하는 값과 같다. 요약 뒤에는 그 추정치), `context_window`(세션 모델의 context window).
- **AskUserQuestion:**
  - 질문이 오면 `status: "requires_action"`과 `function_call` 항목을 보낸다.
  - 답은 `function_call_output`으로 받는다.
  - call_id가 다르면 400이다. 대기 중에 일반 메시지가 오면 409다.
- **interactive:** 사용자가 답할 수 없는 요청이면 `interactive: false`를 준다 (기본 `true`). 그 세션(하위 agent 포함)에서 사용자에게 묻는 도구(지금은 `AskUserQuestion`)를 뺀다.
  - 세션을 만들 때 정해진다. 이어가는 턴에 같은 값을 다시 보내는 것은 되고, 다른 값이면 400이다.
- **read_only:** 남이 쓴 내용이 이 사용자의 sandbox를 움직이는 요청이면 `read_only: true`를 준다 (기본 `false`). 그 세션(하위 agent 포함)에서 sandbox를 바꾸거나 명령을 실행하는 도구(`write`, `edit`, `bash`, sandbox에서 도는 MCP 서버)를 뺀다. `read`, `ls`, `find`, `grep`, `present_file`과 broker MCP 서버는 남는다.
  - 세션을 만들 때 정해진다. 이어가는 턴에 같은 값을 다시 보내는 것은 되고, 다른 값이면 400이다.
- **sandbox_env:** 서비스 키 요청은 `sandbox_env`(이름→값 문자열 객체)로 그 턴의 `bash` 명령 env를 줄 수 있다. BFF가 자기 사용자의 비밀값을 그 사용자의 셸에 넘기는 용도다.
  - 사용자 키 요청이나 관리 화면 채팅이 보내면 403 `sandbox_env_not_allowed`다. 이름은 env 문법이어야 하고, sandbox가 쓰는 이름(`PATH`, `HOME`, `*_PROXY`, `LD_*`, `BASH*`, `LC_*` 등)은 400이다. 최대 64개, 합계 256KiB.
  - 매 요청마다 다시 보낸다. gateway는 그 요청의 값만 쓰고 메모리에만 둔다 — DB·세션 JSONL·로그·관리 화면에 남기지 않으므로 재시작이나 유휴 정리 뒤에도 다음 요청의 값이 그대로 쓰인다. 보내지 않은 턴(AskUserQuestion 답 포함)의 `bash`에는 아무것도 들어가지 않는다.
  - `bash`(하위 agent 포함)에만 넘기고 다른 도구·sandbox MCP 서버에는 넘기지 않는다.
  - 값(원문·base64·hex·URL·JSON 형태, 4자 이상)은 모든 도구의 결과·진행 상황·오류에서 `[REDACTED]`로 바뀐 뒤 모델·클라이언트·세션 기록으로 간다. workspace 파일 내용(`GET /v1/files/content`)은 가리지 않는다.
  - `sandbox_env`가 있는 턴에서 인자에 `[REDACTED]`가 든 도구 호출은 실행하지 않고 오류를 돌려준다 (가린 결과를 그대로 옮겨 쓰면 파일의 원래 값이 그 글자로 바뀌므로).
- **구조화된 출력:** `text.format`에 `json_schema`(최상위 `type: "object"`)를 주면 최종 답이 그 스키마의 JSON이 된다. 스키마에 `pattern`·`patternProperties`(정규식)가 있으면 400이다.
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
