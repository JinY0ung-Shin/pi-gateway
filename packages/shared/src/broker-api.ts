import { z } from "zod";
import { McpServerConfig } from "./mcp-config.js";

/**
 * gateway ↔ mcp-broker 계약.
 *
 * 데이터 평면 (BROKER_PORT, control 네트워크)
 *   - 인증: `Authorization: Bearer <internal JWT, aud=AUD_BROKER, sub=principal, sid, ctx>`
 *   - POST /mcp/:serverId  — MCP Streamable HTTP, 프로토콜 2025-11-25, stateless.
 *     (pi-mcp 클라이언트가 2025-11-25만 지원한다.) GET/DELETE는 405로 답해도 된다.
 *     도구 목록은 toolAllow/toolDeny로 거른 결과다. 도구 이름은 MCP 원래 이름 그대로다
 *     (`mcp__…` 접두사는 gateway가 붙인다).
 *   - GET  /mcp/servers    — 이 사용자가 쓸 수 있는(enabled) 서버 목록. 빠진 비밀키는 빈 값으로 보낸다
 *
 * 관리 평면 (BROKER_ADMIN_PORT, control 네트워크)
 *   - 인증: `Authorization: Bearer <internal JWT, aud=AUD_BROKER_ADMIN>`.
 *   - 비밀값은 어떤 응답에도 들어가지 않는다 (이름, 설정 시각, fingerprint만).
 *   - 오류 응답: `{ error: { code, message } }`
 */

export const BROKER_ROUTES = {
  servers: "/mcp/servers",
} as const;

export const BROKER_ADMIN_ROUTES = {
  servers: "/admin/servers",
  server: (id: string) => `/admin/servers/${encodeURIComponent(id)}`,
  secret: (id: string, name: string) => `/admin/servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`,
  test: (id: string) => `/admin/servers/${encodeURIComponent(id)}/test`,
} as const;

export const SecretName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

/** PUT /admin/servers/:id/secrets/:name → 204 */
export const PutSecretRequest = z.object({ value: z.string().min(1).max(64 * 1024) });

export const SecretInfo = z.object({
  name: z.string(),
  setAt: z.string(),
  /** HMAC 기반 짧은 식별값. 같은 값이 설정됐는지 비교하는 용도이고, 값을 복원할 수 없다. */
  fingerprint: z.string(),
});
export type SecretInfo = z.infer<typeof SecretInfo>;

export const ToolSummary = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type ToolSummary = z.infer<typeof ToolSummary>;

export const McpServerStatus = z.object({
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
});

export const McpServerView = z.object({
  config: McpServerConfig,
  secrets: z.array(SecretInfo),
  /** 설정이 참조하지만 아직 값이 없는 비밀키 이름. 비어 있지 않으면 서버를 쓸 수 없다. */
  missingSecrets: z.array(z.string()),
  status: McpServerStatus.optional(),
});
export type McpServerView = z.infer<typeof McpServerView>;

/** GET /admin/servers */
export const ListServersResponse = z.object({ servers: z.array(McpServerView) });
/** PUT /admin/servers/:id — 본문은 McpServerConfig (runIn은 "broker"여야 한다). 응답은 McpServerView. */

/** POST /admin/servers/:id/test */
export const TestServerResponse = z.object({
  ok: z.boolean(),
  tools: z.array(ToolSummary).optional(),
  error: z.string().optional(),
  durationMs: z.number(),
});
export type TestServerResponse = z.infer<typeof TestServerResponse>;

/** GET /mcp/servers (데이터 평면) */
export const VisibleServer = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  timeoutSec: z.number().int(),
});
export type VisibleServer = z.infer<typeof VisibleServer>;
export const VisibleServersResponse = z.object({ servers: z.array(VisibleServer) });
