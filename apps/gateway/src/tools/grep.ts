import { basename, relative } from "node:path";
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  type GrepToolDetails,
  type ToolDefinition,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { SandboxHandle } from "../sandbox/client.js";
import { resolveSandboxPath } from "./remote-fs.js";

/**
 * grep 도구 — pi 정의는 그대로 쓰고, ripgrep을 gateway가 아니라 sandbox 안에서 실행한다.
 * (pi 내장 grep은 operations를 줘도 gateway에서 rg를 띄운다.)
 * context 줄도 rg의 `--context`로 받아서 파일 전체를 읽지 않는다.
 */

const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

export function createSandboxGrepTool(sandbox: SandboxHandle): ToolDefinition {
  const base = createGrepToolDefinition(SANDBOX_WORKSPACE);
  const definition: typeof base = {
    ...base,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { pattern, path, glob, ignoreCase, literal, context, limit } = params;
      const cwd = ctx?.cwd || SANDBOX_WORKSPACE;
      const searchPath = resolveSandboxPath(path || ".", cwd);
      const st = await sandbox.stat(searchPath, signal);
      if (!st.exists) throw new Error(`Path not found: ${searchPath}`);
      const isDirectory = st.kind === "dir" || st.targetIsDir === true;
      const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
      const contextValue = context && context > 0 ? Math.floor(context) : 0;

      const argv = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
      if (ignoreCase) argv.push("--ignore-case");
      if (literal) argv.push("--fixed-strings");
      if (glob) argv.push("--glob", glob);
      if (contextValue > 0) argv.push("--context", String(contextValue));
      argv.push("--", pattern, searchPath);

      const formatPath = (filePath: string) => {
        if (isDirectory) {
          const rel = relative(searchPath, filePath);
          if (rel && !rel.startsWith("..")) return rel;
        }
        return basename(filePath);
      };

      const lines: string[] = [];
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      let stderr = "";
      let pending = "";
      const stop = new AbortController();
      const onOuterAbort = () => stop.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      const handleLine = (raw: string) => {
        if (!raw.trim() || matchLimitReached) return;
        let event: RgEvent;
        try {
          event = JSON.parse(raw) as RgEvent;
        } catch {
          return;
        }
        if (event.type !== "match" && event.type !== "context") return;
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        if (!filePath || typeof lineNumber !== "number") return;
        const text = (event.data?.lines?.text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
        const { text: shown, wasTruncated } = truncateLine(text, GREP_MAX_LINE_LENGTH);
        if (wasTruncated) linesTruncated = true;
        if (event.type === "match") {
          matchCount++;
          lines.push(`${formatPath(filePath)}:${lineNumber}: ${shown}`);
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            stop.abort();
          }
        } else {
          lines.push(`${formatPath(filePath)}-${lineNumber}- ${shown}`);
        }
      };

      let exitCode: number | null = null;
      try {
        const result = await sandbox.exec(
          { argv, cwd },
          {
            onStdout: (chunk) => {
              pending += chunk.toString("utf8");
              let nl = pending.indexOf("\n");
              while (nl >= 0) {
                handleLine(pending.slice(0, nl));
                pending = pending.slice(nl + 1);
                nl = pending.indexOf("\n");
              }
            },
            onStderr: (chunk) => {
              if (stderr.length < 8192) stderr += chunk.toString("utf8");
            },
            signal: stop.signal,
          },
        );
        handleLine(pending);
        exitCode = result.exitCode;
      } catch (err) {
        // 결과 개수 제한에 걸려서 멈춘 것이면 정상이다.
        if (!(matchLimitReached && err instanceof Error && err.message === "aborted")) {
          if (signal?.aborted) throw new Error("Operation aborted");
          throw err;
        }
      } finally {
        signal?.removeEventListener("abort", onOuterAbort);
      }

      if (!matchLimitReached && exitCode !== 0 && exitCode !== 1 && matchCount === 0) {
        throw new Error(stderr.trim() || `ripgrep exited with code ${exitCode}`);
      }
      if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

      const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
        details.matchLimitReached = effectiveLimit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
    },
  };
  return definition as unknown as ToolDefinition;
}
