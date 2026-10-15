import type {
  JsonRpcMessage,
  McpTransport,
  McpTransportCloseListener,
  McpTransportErrorListener,
  McpTransportMessageListener,
} from "@earendil-works/pi-mcp";
import { parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import type { AttachedProcess } from "../sandbox/client.js";

/** 한 줄 JSON-RPC 메시지의 최대 크기 (MCP stdio 관례와 같은 10MB) */
const MAX_LINE_BYTES = 10 * 1024 * 1024;

/**
 * sandbox 안의 stdio MCP 서버(sandboxd `/v1/attach`)에 붙는 transport.
 * 메시지는 줄바꿈으로 구분된 JSON-RPC다 (MCP stdio transport와 같다).
 */
export class AttachedStdioTransport implements McpTransport {
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  private proc: AttachedProcess | undefined;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly spawn: () => Promise<AttachedProcess>,
    private readonly onStderr?: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    const proc = await this.spawn();
    this.proc = proc;
    proc.onStdout((chunk) => this.handleStdout(chunk));
    proc.onStderr((chunk) => this.onStderr?.(chunk.toString("utf8")));
    proc.onExit((info) => {
      if (info.error) this.emitError(new Error(info.error));
      this.emitClose();
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.emitError(new Error("MCP message exceeds the maximum size"));
      return;
    }
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) {
        try {
          const message = parseJsonRpcMessage(JSON.parse(line));
          for (const l of this.messageListeners) l(message);
        } catch (err) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      nl = this.buffer.indexOf("\n");
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.proc || this.closed) throw new Error("MCP transport is closed");
    this.proc.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.proc?.close();
    this.emitClose();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private emitError(error: Error): void {
    for (const l of this.errorListeners) l(error);
  }

  private emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) l();
  }
}
