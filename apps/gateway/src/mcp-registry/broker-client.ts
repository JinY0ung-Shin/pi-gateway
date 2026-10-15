import {
  AUD_BROKER,
  BROKER_ADMIN_ROUTES,
  BROKER_ROUTES,
  ListAuditResponse,
  ListServersResponse,
  ListToolsResponse,
  type McpServerConfig,
  McpServerView,
  signInternalToken,
  TestServerResponse,
  type AuditEvent,
  type ToolSummary,
  type VisibleServer,
  VisibleServersResponse,
} from "@pi-gateway/shared";
import type { z } from "zod";
import { PlatformError } from "../admin/errors.js";
import type { GatewayConfig } from "../config.js";

export type BrokerConfig = NonNullable<GatewayConfig["broker"]>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ADMIN_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;
const DATA_TIMEOUT_MS = 5_000;

/** broker 호출 실패. 4xx는 broker가 거절한 것, 503은 연결 실패, 502는 broker 오류나 잘못된 응답이다. */
export class BrokerError extends PlatformError {}

/**
 * mcp-broker 클라이언트. 관리 평면(BROKER_ADMIN_TOKEN)과 데이터 평면(내부 JWT)을 함께 다룬다.
 * 비밀값은 putSecret의 본문으로만 지나가고, 로그나 오류 메시지에는 넣지 않는다.
 */
export class BrokerClient {
  readonly #config: BrokerConfig;
  readonly #fetch: FetchLike;

  constructor(config: BrokerConfig, fetchImpl: FetchLike = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  // ── 관리 평면 ──────────────────────────────────────────────────

  async listServers(): Promise<McpServerView[]> {
    const body = await this.#admin("GET", BROKER_ADMIN_ROUTES.servers);
    return this.#parse(ListServersResponse, body).servers;
  }

  /** 없으면 undefined */
  async getServer(id: string): Promise<McpServerView | undefined> {
    try {
      return this.#parse(McpServerView, await this.#admin("GET", BROKER_ADMIN_ROUTES.server(id)));
    } catch (error) {
      if (error instanceof BrokerError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** 만들면 201, 바꾸면 200 (둘 다 McpServerView) */
  async putServer(config: McpServerConfig, actor: string): Promise<McpServerView> {
    const body = await this.#admin("PUT", BROKER_ADMIN_ROUTES.server(config.id), { body: config, actor });
    return this.#parse(McpServerView, body);
  }

  /** 없으면 false */
  async deleteServer(id: string, actor: string): Promise<boolean> {
    try {
      await this.#admin("DELETE", BROKER_ADMIN_ROUTES.server(id), { actor });
      return true;
    } catch (error) {
      if (error instanceof BrokerError && error.status === 404) return false;
      throw error;
    }
  }

  async putSecret(id: string, name: string, value: string, actor: string): Promise<void> {
    await this.#admin("PUT", BROKER_ADMIN_ROUTES.secret(id, name), { body: { value }, actor });
  }

  async deleteSecret(id: string, name: string, actor: string): Promise<void> {
    await this.#admin("DELETE", BROKER_ADMIN_ROUTES.secret(id, name), { actor });
  }

  async test(id: string, user: string | undefined, actor: string): Promise<z.infer<typeof TestServerResponse>> {
    const body = await this.#admin("POST", BROKER_ADMIN_ROUTES.test(id), {
      body: user ? { user } : {},
      actor,
      timeoutMs: TEST_TIMEOUT_MS,
    });
    return this.#parse(TestServerResponse, body);
  }

  async tools(id: string, user: string | undefined): Promise<ToolSummary[]> {
    const query = user ? `?user=${encodeURIComponent(user)}` : "";
    const body = await this.#admin("GET", `${BROKER_ADMIN_ROUTES.tools(id)}${query}`, { timeoutMs: TEST_TIMEOUT_MS });
    return this.#parse(ListToolsResponse, body).tools;
  }

  async audit(limit: number): Promise<AuditEvent[]> {
    const body = await this.#admin("GET", `${BROKER_ADMIN_ROUTES.audit}?limit=${Math.max(1, Math.min(limit, 1000))}`);
    return this.#parse(ListAuditResponse, body).events;
  }

  // ── 데이터 평면 ────────────────────────────────────────────────

  async visibleServers(principal: string, sessionId: string): Promise<VisibleServer[]> {
    const token = await signInternalToken(this.#config.jwtSecret, AUD_BROKER, { sub: principal, sid: sessionId }, 60);
    const body = await this.#request(`${this.#config.url}${BROKER_ROUTES.servers}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeoutMs: DATA_TIMEOUT_MS,
    });
    return this.#parse(VisibleServersResponse, body).servers;
  }

  // ── 내부 ───────────────────────────────────────────────────────

  async #admin(
    method: string,
    path: string,
    options: { body?: unknown; actor?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#config.adminToken}`,
      accept: "application/json",
    };
    if (options.actor) headers["x-admin-actor"] = encodeURIComponent(options.actor);
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(options.body);
    }
    return this.#request(`${this.#config.adminUrl}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      timeoutMs: options.timeoutMs ?? ADMIN_TIMEOUT_MS,
    });
  }

  async #request(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(init.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new BrokerError(503, "broker_unavailable", `MCP broker is ${reason}; the change was not applied — try again when the broker is back`);
    }
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (!response.ok) {
      const err = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof err?.code === "string" ? err.code : `broker_${response.status}`;
      const message = typeof err?.message === "string" ? err.message : `MCP broker returned HTTP ${response.status}`;
      // 4xx는 broker의 판단을 그대로 전달하고, 5xx는 502로 바꾼다.
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw new BrokerError(status, code, message);
    }
    return body;
  }

  #parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new BrokerError(502, "broker_bad_response", "unexpected response from the MCP broker");
    return result.data;
  }
}
