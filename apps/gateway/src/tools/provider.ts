import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RequestContext } from "@pi-gateway/shared";
import type { Logger } from "pino";
import type { ToolCatalogEntry } from "../contracts.js";
import type { SandboxClient, SandboxHandle } from "../sandbox/client.js";

/**
 * 도구 확장 단위. 새 도구는 provider를 하나 만들어 src/tools/registry.ts의 목록에 추가한다.
 * (자세한 방법: docs/EXTENDING.md)
 *
 * 도구를 어디서 실행할지 정하는 규칙 — 반드시 지킨다:
 * 1. 사용자 영향을 받는 코드를 실행하거나 파일을 만지는 도구는 반드시 sandbox(sandboxd)를 거친다.
 *    gateway 프로세스에서 사용자 파일을 열거나 명령을 띄우지 않는다.
 * 2. 비밀값(API 키, 토큰)이 필요한 도구는 반드시 broker(MCP)를 거친다.
 *    gateway env·설정·디스크에 비밀을 두지 않는다.
 * 3. gateway 안에서 직접 실행하는 도구는 오케스트레이션 용도만 둔다 (예: AskUserQuestion).
 */

export interface ToolSessionContext {
  /** 사용자 id 또는 `_anon-<sessionId>` */
  principal: string;
  /** 익명이면 null */
  user: string | null;
  sessionId: string;
  model: string;
  sandboxClient: SandboxClient;
  /** sandboxClient.for(principal, sessionId) — 이 세션 전용 sandbox 핸들 */
  sandbox: SandboxHandle;
  /** 현재 요청의 전달 헤더·metadata (allowlist를 거친 값). 턴마다 바뀔 수 있어 함수로 준다. */
  requestContext: () => RequestContext;
  log: Logger;
  /** 세션 생성이 취소되면 abort된다 */
  signal: AbortSignal;
}

export type ToolEntryMeta = Pick<ToolCatalogEntry, "enabledByDefault" | "required">;

export interface ToolProvider {
  /** catalog의 provider 값. 정책·관리 화면에서 이 id로 보인다. */
  id: string;
  description: string;
  /** 관리 화면용 목록. 사용자·서버에 따라 바뀌는 도구는 dynamic 대표 항목으로 보여준다. */
  catalog(): Promise<ToolCatalogEntry[]>;
  /** 세션 하나에 붙일 도구 정의 */
  createTools(ctx: ToolSessionContext): Promise<ToolDefinition[]>;
  /** 세션이 정리될 때 연결·프로세스를 닫는다 */
  disposeSession?(sessionId: string): Promise<void>;
  /** 도구 이름 → 정책 기본값. 없으면 enabledByDefault=true, required=false. */
  entryFor?(toolName: string): ToolEntryMeta | undefined;
}

/** 고정된 도구 목록을 가진 provider의 entryFor 구현 */
export function staticEntryLookup(entries: readonly ToolCatalogEntry[]): (name: string) => ToolEntryMeta | undefined {
  const byName = new Map(entries.map((e) => [e.name, { enabledByDefault: e.enabledByDefault, ...(e.required ? { required: true } : {}) }]));
  return (name) => byName.get(name);
}
