import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthResult } from "../auth/auth.js";
import { apiError, badRequest, notFound } from "../errors.js";
import { SandboxError } from "../sandbox/client.js";
import { MAX_PRESENT_BYTES, mimeTypeOf, workspaceFilePath } from "../tools/present-file.js";
import { type ResponsesDeps, userOf } from "./responses.js";

/**
 * GET /v1/files/content?path=&user= — present_file로 보여준 workspace 파일을 내려준다.
 * 인증과 user 규칙은 `/v1/responses`와 같다. 파일은 sandboxd로 읽는다 (gateway 로컬 파일을 열지 않는다).
 * 관리 화면과 같은 origin이라 HTML·SVG가 여기서 실행되지 않도록 CSP sandbox와 attachment로 보낸다.
 */
export function registerFileRoutes(app: FastifyInstance, deps: ResponsesDeps): void {
  app.get("/v1/files/content", async (req, reply) => sendWorkspaceFile(deps, req, reply, deps.auth.authenticate(req.headers.authorization)));
}

/** 인증은 호출하는 쪽이 한다 (API 키, 또는 관리 화면 채팅은 관리자 로그인). */
export async function sendWorkspaceFile(deps: ResponsesDeps, req: FastifyRequest, reply: FastifyReply, auth: AuthResult): Promise<unknown> {
  const query = req.query as { path?: unknown; user?: string };
  const user = userOf(auth, query.user);
  const path = typeof query.path === "string" ? workspaceFilePath(query.path) : null;
  if (!path) throw badRequest("path must be a file under /workspace");

  let file: { content: Buffer; truncated: boolean };
  try {
    file = await deps.sandbox.for(user, "").readFile(path, MAX_PRESENT_BYTES);
  } catch (err) {
    if (!(err instanceof SandboxError)) throw err;
    if (err.code === "not_found") throw notFound(`File '${path}' not found`);
    if (err.code === "is_directory") throw badRequest(`'${path}' is a directory`);
    deps.log.warn({ err, user, path }, "file download failed");
    throw apiError(502, `Sandbox error: ${err.message}`);
  }
  if (file.truncated) throw apiError(413, `File '${path}' is larger than ${MAX_PRESENT_BYTES} bytes`);

  // RFC 5987: encodeURIComponent가 남기는 ' ( ) *도 인코딩한다.
  const name = encodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return reply
    .headers({
      "content-type": mimeTypeOf(path),
      "content-disposition": `attachment; filename*=UTF-8''${name}`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    })
    .send(file.content);
}
