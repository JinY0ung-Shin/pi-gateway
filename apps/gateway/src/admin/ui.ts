import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export const ADMIN_UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const NOT_BUILT = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>pi-gateway 관리</title>
<body style="font-family:sans-serif;padding:2rem"><h1>관리 화면이 아직 빌드되지 않았습니다</h1>
<p><code>npm run build -w @pi-gateway/admin-ui</code>를 실행한 뒤 gateway를 다시 시작하세요.</p></body></html>`;

/** `/admin` 아래에서 관리 화면 SPA를 제공한다. 이 함수는 prefix "/admin"으로 등록된 scope에서 호출된다. */
export async function registerAdminUi(app: FastifyInstance, uiDir: string): Promise<void> {
  const indexPath = join(uiDir, "index.html");

  const sendIndex = async (reply: FastifyReply) => {
    let html: string;
    try {
      // 빌드가 바뀌어도 바로 보이도록 매번 읽는다 (작은 파일이다).
      html = await readFile(indexPath, "utf8");
    } catch {
      return reply.code(503).type("text/html; charset=utf-8").header("content-security-policy", ADMIN_UI_CSP).send(NOT_BUILT);
    }
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("content-security-policy", ADMIN_UI_CSP)
      .send(html);
  };

  app.get("/", async (_req, reply) => sendIndex(reply));

  const assets = join(uiDir, "assets");
  if (existsSync(assets)) {
    await app.register(fastifyStatic, {
      root: assets,
      prefix: "/assets/",
      decorateReply: false,
      index: false,
      immutable: true,
      maxAge: "365d",
    });
  }

  // hash 라우팅을 쓰지만, 직접 들어온 하위 경로도 index.html로 보낸다.
  app.setNotFoundHandler(async (req, reply) => {
    const accept = String(req.headers.accept ?? "");
    if (req.method === "GET" && accept.includes("text/html")) return sendIndex(reply);
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  });
}
