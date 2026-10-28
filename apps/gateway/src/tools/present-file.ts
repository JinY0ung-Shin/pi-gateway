import { posix } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { Type } from "typebox";
import type { SandboxHandle } from "../sandbox/client.js";
import { MAX_READ_BYTES, resolveSandboxPath, toFsError } from "./remote-fs.js";

/**
 * present_file — workspace 파일을 클라이언트에 보여준다.
 * 파일이 있는지만 확인하고 메타데이터를 결과 details에 싣는다. gateway는 이것을 `type: "file"` 출력 항목으로
 * 내보내고, 클라이언트는 `GET /v1/files/content`로 내용을 받아 mime_type에 맞게 렌더링한다.
 */

export const PRESENT_FILE_TOOL = "present_file";
/** `GET /v1/files/content`가 한 번에 내려주는 크기 */
export const MAX_PRESENT_BYTES = MAX_READ_BYTES;

export interface PresentedFile {
  path: string;
  filename: string;
  mime_type: string;
  size: number;
}

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mimeTypeOf(path: string): string {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/** `/workspace` 아래 절대 경로로 바꾼다. 밖이면 null. */
export function workspaceFilePath(path: string): string | null {
  const p = resolveSandboxPath(path, SANDBOX_WORKSPACE);
  return p.startsWith(`${SANDBOX_WORKSPACE}/`) ? p : null;
}

const PresentFileParams = Type.Object({
  path: Type.String({ description: "Path of the file under /workspace (absolute or relative to /workspace)." }),
});

export function createPresentFileTool(sandbox: SandboxHandle): ToolDefinition<typeof PresentFileParams> {
  return {
    name: PRESENT_FILE_TOOL,
    label: "Present file",
    description:
      "Show a finished file from the workspace to the user, such as an image, HTML page, PDF or office document. " +
      "The user's app renders it or offers a download. Call it once per file, after the file is complete. " +
      `Only files under ${SANDBOX_WORKSPACE} can be presented.`,
    parameters: PresentFileParams,
    async execute(_toolCallId, params, signal) {
      const path = workspaceFilePath(params.path);
      if (!path) throw new Error(`Only files under ${SANDBOX_WORKSPACE} can be presented: ${params.path}`);
      const st = await sandbox.stat(path, signal).catch((err: unknown) => {
        throw toFsError(err, "stat", path);
      });
      if (!st.exists) throw new Error(`File not found: ${path}`);
      if (st.kind !== "file") throw new Error(`Not a regular file: ${path}`);
      const size = st.size ?? 0;
      if (size > MAX_PRESENT_BYTES) throw new Error(`File is too large to present (${size} bytes, max ${MAX_PRESENT_BYTES}): ${path}`);
      const file: PresentedFile = { path, filename: posix.basename(path), mime_type: mimeTypeOf(path), size };
      return {
        content: [{ type: "text", text: `Presented ${path} to the user (${file.mime_type}, ${file.size} bytes).` }],
        details: { file },
      };
    },
  };
}
