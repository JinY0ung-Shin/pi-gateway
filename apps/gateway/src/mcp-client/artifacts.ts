import { createHash } from "node:crypto";
import type { CallToolResult, ContentBlock } from "@earendil-works/pi-mcp";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { SandboxHandle } from "../sandbox/client.js";

/**
 * MCP 도구 결과의 파일(바이너리 `resource` 블록)을 사용자의 sandbox에 저장한다.
 * - 위치: `/workspace/artifacts/<세션 id>/<이름>-<sha256 앞 8자><확장자>`. 경로가 내용에서 나오므로
 *   같은 내용은 같은 경로가 되고, 다른 내용은 다른 파일이 된다.
 * - 임시 이름으로 쓰고 rename한다. 쓰다 만 파일이 저장 경로에 남지 않는다.
 * - base64가 깨졌거나 서버가 `resource._meta`에 준 `size`·`sha256`과 다르면 저장하지 않고 도구 오류로 돌려준다.
 * 블록은 저장 결과 텍스트로 바뀐다. 이미지면 블록도 남겨 모델이 본다.
 * uri와 내용은 로그·오류 메시지에 넣지 않는다.
 */

const ARTIFACTS_DIR = `${SANDBOX_WORKSPACE}/artifacts`;

export interface SavedArtifacts {
  content: ContentBlock[];
  /** 저장하지 못한 파일이 있다 */
  failed: boolean;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const FILENAME = /^[^/\\\x00-\x1f\x7f]+$/;

/** uri의 마지막 조각. 파일 이름으로 쓸 수 없으면 `artifact.bin`. */
function fileName(uri: string): string {
  let name = uri.split(/[?#]/)[0]!.split("/").pop() ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // 그대로 본다
  }
  return FILENAME.test(name) && name !== "." && name !== ".." && Buffer.byteLength(name) <= 200 ? name : "artifact.bin";
}

export function hasArtifacts(result: CallToolResult): boolean {
  return (result.content ?? []).some((b) => b.type === "resource" && "blob" in b.resource);
}

export async function saveArtifacts(
  result: CallToolResult,
  sandbox: Pick<SandboxHandle, "sessionId" | "writeFile" | "exec">,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<SavedArtifacts> {
  const dir = `${ARTIFACTS_DIR}/${sandbox.sessionId}`;
  const out: SavedArtifacts = { content: [], failed: false };
  let n = 0;
  for (const block of result.content ?? []) {
    if (block.type !== "resource" || !("blob" in block.resource)) {
      out.content.push(block);
      continue;
    }
    const { uri, blob, mimeType, _meta: declared } = block.resource;
    const mime = mimeType ?? "application/octet-stream";
    const tmp = `${dir}/.part-${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}-${n++}`;
    try {
      if (blob.length % 4 !== 0 || !BASE64.test(blob)) throw new Error("the transfer was truncated or is not valid base64");
      const bytes = Buffer.from(blob, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (typeof declared?.size === "number" && declared.size !== bytes.length) {
        throw new Error(`received ${bytes.length} bytes, but the server declared ${declared.size}`);
      }
      if (typeof declared?.sha256 === "string" && declared.sha256.toLowerCase() !== sha256) {
        throw new Error("the sha256 of the received bytes does not match the one the server declared");
      }
      const name = fileName(uri);
      const dot = name.lastIndexOf(".");
      const path = `${dir}/${dot > 0 ? name.slice(0, dot) : name}-${sha256.slice(0, 8)}${dot > 0 ? name.slice(dot) : ""}`;
      await sandbox.writeFile(tmp, bytes, signal);
      const moved = await sandbox.exec({ argv: ["mv", "-f", tmp, path], timeoutSec: 30 }, signal ? { signal } : {});
      if (moved.exitCode !== 0) throw new Error("the file could not be moved into place");
      const saved = { saved_path: path, size: bytes.length, sha256, mime, truncated: false };
      out.content.push({ type: "text", text: `Saved to the workspace: ${JSON.stringify(saved)}` });
      if (mime.startsWith("image/")) out.content.push(block);
    } catch (err) {
      if (signal?.aborted) throw err;
      out.failed = true;
      out.content.push({ type: "text", text: `[File (${mime}) was not saved: ${err instanceof Error ? err.message : String(err)}]` });
      await sandbox.exec({ argv: ["rm", "-f", tmp], timeoutSec: 30 }).catch(() => {});
    }
  }
  return out;
}
