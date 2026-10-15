import {
  type BashToolDetails,
  createBashToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  type ToolDefinition,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { SandboxHandle } from "../sandbox/client.js";

/**
 * bash 도구 — pi 정의(이름·스키마·설명)는 그대로 쓰고 execute만 sandbox 실행으로 바꾼다.
 * pi 내장 execute는 gateway의 process.env 전체를 넘기고 긴 출력을 gateway /tmp에 쓰기 때문이다.
 */

/** sandbox에서 받아 둘 출력 상한. 이보다 많으면 앞부분은 버리고 sandbox의 전체 출력 파일을 안내한다. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const UPDATE_THROTTLE_MS = 100;

export interface SandboxBashOptions {
  /** sandbox 명령에 넘길 추가 env (allowlist된 값만) */
  env?: () => Record<string, string>;
}

const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

export function createSandboxBashTool(sandbox: SandboxHandle, options: SandboxBashOptions = {}): ToolDefinition {
  const base = createBashToolDefinition(SANDBOX_WORKSPACE, { exposeSessionEnvironment: false });
  const definition: typeof base = {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, timeout } = params;
      const cwd = ctx?.cwd || SANDBOX_WORKSPACE;
      const chunks: Buffer[] = [];
      let captured = 0;
      let dropped = false;
      let updateTimer: NodeJS.Timeout | undefined;
      let lastUpdate = 0;

      const snapshot = () => truncateTail(Buffer.concat(chunks).toString("utf8"));
      const flushUpdate = () => {
        updateTimer = undefined;
        lastUpdate = Date.now();
        const t = snapshot();
        onUpdate?.({ content: [{ type: "text", text: t.content }], details: t.truncated ? { truncation: t } : undefined });
      };
      const onData = (chunk: Buffer) => {
        if (captured + chunk.length > MAX_CAPTURE_BYTES) {
          dropped = true;
          // 끝부분을 유지한다 (오류는 보통 끝에 있다).
          chunks.push(chunk);
          captured += chunk.length;
          while (captured > MAX_CAPTURE_BYTES && chunks.length > 1) captured -= chunks.shift()!.length;
        } else {
          chunks.push(chunk);
          captured += chunk.length;
        }
        if (!onUpdate || updateTimer) return;
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdate);
        updateTimer = setTimeout(flushUpdate, Math.max(0, delay));
      };

      const startedAt = performance.now();
      let result: Awaited<ReturnType<SandboxHandle["exec"]>>;
      try {
        onUpdate?.({ content: [], details: undefined });
        result = await sandbox.exec(
          {
            argv: ["bash", "-c", command],
            cwd,
            env: options.env?.() ?? {},
            ...(timeout && timeout > 0 ? { timeoutSec: Math.ceil(timeout) } : {}),
          },
          { onStdout: onData, onStderr: onData, signal },
        );
      } catch (err) {
        const partial = snapshot().content;
        if (err instanceof Error && err.message === "aborted") throw new Error(appendStatus(partial, "Command aborted"));
        throw new Error(appendStatus(partial, `Command failed to run in the sandbox: ${(err as Error).message}`));
      } finally {
        if (updateTimer) clearTimeout(updateTimer);
      }

      const fullBuffer = Buffer.concat(chunks);
      const full = fullBuffer.toString("utf8");
      const truncation = truncateTail(full);
      let text = truncation.content || "(no output)";
      let details: BashToolDetails | undefined;
      const wasTruncated = truncation.truncated || dropped || result.truncated;
      if (wasTruncated) {
        const fullOutputPath = `/tmp/pi-bash-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.log`;
        let saved = true;
        try {
          await sandbox.writeFile(fullOutputPath, fullBuffer);
        } catch {
          saved = false;
        }
        details = { truncation, ...(saved ? { fullOutputPath } : {}) };
        const where = saved ? `Full output: ${fullOutputPath}` : "Full output could not be saved";
        const lost = dropped || result.truncated ? " (earlier output was discarded)" : "";
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        text += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}${
          truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""
        }${lost}. ${where}]`;
      }

      if (result.timedOut) throw new Error(appendStatus(text, `Command timed out after ${timeout} seconds`));
      if (result.exitCode === null) {
        throw new Error(appendStatus(text, result.signal ? `Command terminated by signal ${result.signal}` : "Command terminated without an exit code"));
      }
      const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
      const structuredContent = {
        output: full.length > 1024 * 1024 ? full.slice(-1024 * 1024) : full,
        truncated: wasTruncated,
        ...(details?.fullOutputPath ? { full_output_path: details.fullOutputPath } : {}),
        exit_code: result.exitCode,
        wall_time_seconds: wallTimeSeconds,
      };
      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text", text: appendStatus(text, `Command exited with code ${result.exitCode}`) }],
          details,
          structuredContent,
          isError: true,
        };
      }
      return { content: [{ type: "text", text }], details, structuredContent };
    },
  };
  return definition as unknown as ToolDefinition;
}
