# 도구 확장 가이드

agent가 쓸 수 있는 도구를 늘리는 방법이에요. 대부분은 코드를 고치지 않고 관리 화면이나 이미지 빌드 인자로 끝나요.

## 먼저: 도구를 어디서 실행할지 정하는 규칙

모든 도구는 아래 규칙을 지켜야 해요. 코드 리뷰에서도 이 기준으로 봐요.

1. **사용자 영향을 받는 코드를 실행하거나 파일을 만지는 도구는 반드시 sandbox를 거쳐요.**
   gateway 프로세스 안에서 사용자 파일을 열거나 명령을 띄우면 안 돼요. sandbox 컨테이너에는 그 사용자의 workspace만 있고 비밀이 없어요.
2. **비밀값(API 키, 토큰)이 필요한 도구는 반드시 broker(MCP)를 거쳐요.**
   gateway의 env, 설정 파일, 디스크에 비밀을 두지 않아요. 키는 mcp-broker에만 있고, agent도 gateway도 원문을 보지 않아요.
3. **gateway 안에서 직접 실행하는 도구는 흐름 제어용만 둬요.**
   예: AskUserQuestion (질문을 보여주고 턴을 끝내는 것뿐, 파일·명령·비밀을 만지지 않아요).

## 한눈에 보기

| 추가하려는 것 | 방법 | 코드 수정 | 반영 시점 |
|---|---|---|---|
| 인증키가 필요한 외부 API·사내 시스템 | [broker MCP 서버 등록](#1-mcp-서버-추가-코드-수정-없음) | 없음 | 새 세션부터 |
| workspace 파일을 다루고 키가 필요 없는 도구 | [sandbox MCP 서버 등록](#1-mcp-서버-추가-코드-수정-없음) | 없음 | 새 세션부터 |
| 작업 절차·스크립트 묶음 | [plugin skill 설치](#2-plugin-skill-추가-코드-수정-없음) | 없음 | 새 세션부터 |
| agent가 bash로 쓰는 CLI 프로그램 | [sandbox 이미지에 패키지 추가](#3-sandbox에-cli-패키지-추가-이미지-재빌드) | 없음 (이미지 재빌드) | 컨테이너 재생성 후 |
| gateway와 깊게 연동되는 도구 | [새 ToolProvider 작성](#4-새-toolprovider-작성-코드-수정) | 있음 | gateway 재배포 후 |

---

## 1. MCP 서버 추가 (코드 수정 없음)

관리 화면의 **MCP** 페이지에서 서버를 등록해요. 실행 위치(`runIn`)를 먼저 골라요.

| | `broker` | `sandbox` |
|---|---|---|
| 언제 쓰나 | 인증키가 필요한 서버 (GitHub, 사내 API 등) | 키가 필요 없고 사용자 workspace 파일을 다루는 서버 |
| 어디서 도나 | 원격 서버 (broker가 비밀키를 붙여 프록시) | 그 사용자의 sandbox 컨테이너 안 (stdio) |
| 쓸 수 있는 transport | `http` (streamable HTTP)만 | `stdio`만 |
| 비밀값 | `{{secret:NAME}}`로 참조, 값은 관리 화면에서 쓰기 전용으로 입력 | 쓸 수 없음 (설정 검증에서 거부) |

### 설정 예시

비밀키가 필요한 원격 서버 (broker):

```json
{
  "id": "github",
  "runIn": "broker",
  "transport": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer {{secret:GITHUB_TOKEN}}" }
  },
  "toolDeny": ["delete_repository"]
}
```

등록한 뒤 `GITHUB_TOKEN` 값을 입력해야 서버가 활성화돼요. 값은 다시 읽을 수 없고, 이름·설정 시각·fingerprint만 보여요.

workspace 파일을 다루는 서버 (sandbox) — 예: `monsemi-frontend`:

```json
{
  "id": "monsemi-frontend",
  "runIn": "sandbox",
  "scope": "per-session",
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["/opt/plugins/defect-agent-plugins/defect-agent-frontend/current/mcp/server.js"],
    "env": { "SERVICE_URL": "http://orchestrator:9000", "THREAD_ID": "{{metadata:THREAD_ID}}" }
  }
}
```

- 명령은 sandbox 컨테이너 안에서 실행돼요. 실행 파일(`node` 등)과 스크립트가 sandbox 안에 있어야 해요 (`/opt/plugins`는 sandbox에 읽기 전용으로 보여요).
- `{{metadata:KEY}}`는 요청 `metadata`의 값이에요. 쓰려면 gateway 설정 `MCP_METADATA_KEYS`에 그 키를 넣어야 해요.

### 템플릿 자리표시자

| 자리표시자 | 값 | broker | sandbox |
|---|---|---|---|
| `{{secret:NAME}}` | broker 비밀 저장소 값 | ✅ | ❌ |
| `{{ctx.header:NAME}}` | 클라이언트가 보낸 헤더 | ✅ | ❌ |
| `{{user}}` | 사용자 id | ✅ | ✅ |
| `{{session}}` | gateway 세션 id | ✅ | ✅ |
| `{{metadata:KEY}}` | 요청 metadata (`MCP_METADATA_KEYS` allowlist) | ✅ | ✅ |

stdio 서버는 env·args가 프로세스를 띄울 때 정해져요. 그래서 `{{user}}`·`{{ctx.header}}`를 쓰면 `scope`가 `per-user` 이상, `{{session}}`·`{{metadata}}`를 쓰면 `per-session`이어야 해요 (설정 검증이 알려줘요).

### 사용자마다 다른 쿠키가 필요한 서버

로그인 쿠키처럼 사용자마다 다른 자격증명은 클라이언트가 요청 헤더로 보내고, broker가 그 값을 MCP 서버 요청에 붙여요. 값은 agent와 sandbox에 들어가지 않고, broker 연결도 사용자별로 나뉘어요.

예: `foo` 서버가 `JSESSIONID` 쿠키를 요구할 때

1. broker 서버로 등록하고, 값이 들어갈 자리에 `{{ctx.header:<받을 요청 헤더 이름>}}`을 써요. 설정에 쓴 헤더만 broker로 넘어가요. 따로 허용 목록을 둘 필요가 없고 재시작도 필요 없어요.

   ```json
   {
     "id": "foo",
     "runIn": "broker",
     "transport": {
       "type": "http",
       "url": "https://foo.internal/mcp",
       "headers": { "Cookie": "JSESSIONID={{ctx.header:x-foo-session}}" }
     }
   }
   ```

2. 클라이언트가 모든 `/v1/responses` 요청에 `X-Foo-Session: <쿠키 값>`을 붙여요. `previous_response_id`로 이어가는 요청과 AskUserQuestion 답(`function_call_output`)도 마찬가지예요. 가장 최근 요청의 값을 써요.

- 브라우저의 `Cookie` 헤더를 통째로 넘기지 말고 필요한 값 하나만 보내요. broker는 넘겨받은 헤더 값 전체를 도구 결과에서 가리므로, 값이 하나일 때 정확히 가려져요.
- `metadata`에는 넣지 않아요. metadata는 sandbox MCP 서버에도 가요.
- 세션을 처음 열 때 값이 없어 서버가 도구 목록 요청을 거절하면, 그 서버 도구는 세션이 유휴 정리(`SESSION_IDLE_SECONDS`)된 뒤 다시 열릴 때까지 빠져요.
- MCP 서버가 `Set-Cookie`로 준 새 쿠키는 클라이언트로 돌아가지 않아요. 만료되면 클라이언트가 새 값을 보내야 해요.
- plugin이 등록한 서버의 `{{secret:NAME}}`이 사실은 사용자마다 다른 값이면, MCP 페이지에서 그 헤더 값을 `{{ctx.header:…}}`로 바꿔요. 비밀키 목록에서 빠지고, 바꾼 값은 plugin을 업데이트해도 유지돼요.
- MCP 페이지의 연결 확인은 쿠키 없이 해요. 관리 화면 채팅의 헤더 입력칸에 값을 넣어 확인해요.

### 모델에 보이는 이름

`mcp__<서버 id>__<도구 이름>` (예: `mcp__github__create_issue`). `toolAllow`/`toolDeny`로 서버 안의 일부 도구만 노출할 수 있어요.

- 도구는 모델의 도구 목록에 하나씩 넣지 않아요. 모델은 `mcp_search`로 도구와 인자 schema를 찾고 `mcp_call`로 실행해요. 서버가 많아도 도구 목록이 고정돼서 prefix cache가 유지되고, 어느 tool-call parser에서나 동작해요.
- plugin 서버도 같아요. skill에 도구 이름이 적혀 있으면 모델은 검색 없이 `mcp_call`로 바로 불러요.
- `mcp_search` 설명에 서버마다 id, 표시 이름, 설명 첫 줄이 들어가요. 모델은 이걸 보고 어떤 서비스가 있는지 알아요. 서버 설명을 채워 두세요.

---

## 2. plugin skill 추가 (코드 수정 없음)

관리 화면의 **plugin** 페이지에서 Claude Code marketplace를 추가하고 plugin을 설치해요.

- skill(`skills/*/SKILL.md`)은 pi skill로 그대로 쓰여요. 시스템 프롬프트에 이름·설명·경로만 들어가고, 모델이 필요할 때 `read`로 `SKILL.md`를 읽어요.
- plugin 파일은 `/opt/plugins/...`에 설치되고 gateway와 sandbox에서 같은 경로로 보여요. skill에 딸린 스크립트는 sandbox 안에서 `bash`로 실행돼요.
- agent(`agents/*.md`)는 `Agent` 도구로 실행돼요. 하위 세션이 부모와 같은 sandbox·도구로 일하고 최종 답과 `agent_id`를 돌려줘요. `SendMessage`로 같은 agent에 이어서 말할 수 있어요. frontmatter는 `name`·`description`·`tools`만 써요.
- plugin의 `.mcp.json`은 MCP 서버로 등록돼요. 비밀키 자리표시자가 있으면 broker 서버가 되고, 관리자가 키를 넣어야 활성화돼요.
- 직접 만든 skill도 같은 방식이에요: `.claude-plugin/marketplace.json`이 있는 git 저장소를 marketplace로 추가해요.

설치·제거는 새 세션부터 적용돼요 (진행 중인 세션의 시스템 프롬프트를 바꾸지 않아요).

---

## 3. sandbox에 CLI 패키지 추가 (이미지 재빌드)

agent가 `bash`로 쓰는 프로그램은 sandbox 이미지에 미리 설치해요. 실행 중인 sandbox는 시스템 영역이 읽기 전용이라 `apt install`을 할 수 없어요 (pip·npm 패키지는 agent가 workspace 안에 직접 설치할 수 있어요).

파생 이미지(`FROM pi-gateway/sandbox`)를 만들고 `SANDBOX_IMAGE`를 그 이미지로 바꿔요.

- 이미 떠 있는 사용자 컨테이너는 다시 만들어질 때 새 이미지를 써요 ([OPERATIONS.md §3.5](OPERATIONS.md#35-중지재시작업데이트)).
- 운영 절차(빌드·배포·확인)는 [OPERATIONS.md §5 "sandbox에 도구 추가하기"](OPERATIONS.md#5-sandbox에-도구-추가하기)에 있어요.

---

## 4. 새 ToolProvider 작성 (코드 수정)

MCP 서버나 skill로 안 되는 경우에만 써요. 예: 응답 흐름 자체를 바꾸는 도구, gateway가 가진 세션 정보가 꼭 필요한 도구.

### 구조

```
apps/gateway/src/tools/
  provider.ts          ToolProvider·ToolSessionContext 인터페이스 (규칙 주석 포함)
  registry.ts          provider 목록 → pi tools/customTools
  providers/
    sandbox.ts         read, write, edit, ls, find, bash, grep
    ask-user.ts        AskUserQuestion
    mcp.ts             MCP 서버 (broker·sandbox)
```

인터페이스(`ToolProvider`, `ToolSessionContext`)와 각 필드의 뜻은 `provider.ts`의 주석에 있어요. provider는 세션마다 `createTools(ctx)`로 도구를 만들고, 파일·명령은 `ctx.sandbox`로만 다뤄요.

### 순서

1. `apps/gateway/src/tools/providers/<이름>.ts`에 provider를 만들어요.
2. `apps/gateway/src/tools/registry.ts`의 `createDefaultToolProviders()` 목록에 추가해요. 목록 순서가 도구 순서예요.
3. 테스트를 추가해요. 가짜 LLM이 도구를 호출하게 하고 가짜 sandboxd에 간 요청을 확인하는 하네스가 `apps/gateway/test/helpers.ts`에 있어요.
4. gateway를 다시 배포해요.

### 체크리스트

- [ ] 파일·명령을 다루면 `ctx.sandbox`만 쓴다. `node:fs`, `child_process`로 gateway 로컬을 만지지 않는다.
- [ ] 비밀이 필요하면 provider를 만들지 말고 broker MCP 서버로 만든다.
- [ ] `signal`을 존중한다. abort되면 바로 멈춘다 (안 그러면 세션 정리가 늦어진다).
- [ ] 실패는 던지거나 `isError: true`로 돌려준다. 오류 메시지에 비밀·내부 주소를 넣지 않는다.
- [ ] 출력이 클 수 있으면 pi의 `truncateHead`/`truncateTail`로 자른다 (기본 50KB·2000줄).
- [ ] 결과에 이미지를 넣으면 `guardImageBlocks`(`src/tools/image-guard.ts`)를 먼저 거친다. pi가 gateway 프로세스 안에서 이미지를 디코딩하기 때문에, 해상도가 큰 압축 이미지 하나로 메모리가 터질 수 있다 (25MP·20MB 제한).
- [ ] 사용자마다 달라질 수 있는 것(도구 목록 등)을 캐시하면 키에 principal을 넣는다. 사용자 sandbox에서 만든 값을 다른 사용자에게 주지 않는다.
- [ ] sandbox에서 프로그램을 띄우면 이름(`node`)이 아니라 시스템 디렉토리의 절대 경로로 띄운다 (`resolveSandboxCommand`). workspace의 PATH 디렉토리에 심은 실행 파일을 쓰지 않기 위해서다.
- [ ] 연결·프로세스를 만들면 `disposeSession`에서 닫는다.
- [ ] 도구 이름은 `[A-Za-z0-9_-]` 64자 이내이고 다른 provider와 겹치지 않는다.
