import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { RenderedTransport } from "../render.js";

export const BROKER_CLIENT_INFO = { name: "pi-gateway-mcp-broker", version: "0.1.0" } as const;

export interface UpstreamConnection {
  readonly client: Client;
  /** 여러 번 불러도 된다. */
  close(): Promise<void>;
}

export interface ConnectHooks {
  /** upstream 연결이 스스로 끊겼을 때 */
  onClosed(): void;
  onToolsChanged(): void;
}

export interface ConnectOptions {
  connectTimeoutMs: number;
  hooks: ConnectHooks;
}

/** 원격 MCP 서버(streamable HTTP)에 연결한다. */
export async function connectUpstream(rendered: RenderedTransport, options: ConnectOptions): Promise<UpstreamConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(rendered.url), {
    requestInit: { headers: rendered.headers },
    redirectPolicy: "same-origin",
  });
  // sampling·elicitation·roots는 선언하지 않는다 (upstream이 우리에게 되묻는 경로를 막는다).
  const client = new Client({ ...BROKER_CLIENT_INFO }, { capabilities: {} });
  client.setNotificationHandler("notifications/tools/list_changed", () => options.hooks.onToolsChanged());
  let closed = false;
  client.onclose = () => {
    if (!closed) options.hooks.onClosed();
  };
  try {
    await client.connect(transport, { timeout: options.connectTimeoutMs });
  } catch (error) {
    closed = true;
    await client.close().catch(() => {});
    throw error;
  }
  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
    },
  };
}
