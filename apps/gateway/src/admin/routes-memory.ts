import { isValidUserId } from "@pi-gateway/shared";
import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";
import { badRequest, PlatformError } from "./errors.js";

const TIMEOUT_MS = 15_000;

/** 사용자별 장기 메모리 보기 (읽기 전용). memory 서비스의 프로그램용 API(`/wikis`, `/wiki/<주인>/…`)를 대신 부른다. */
export function registerMemoryRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { url, apiKey } = ctx.config.memory;

  /** 실패하면 PlatformError: 4xx는 memory가 거절한 것, 503은 연결 실패, 502는 memory 오류나 키 불일치다. */
  const get = async (path: string, query: Record<string, string> = {}): Promise<unknown> => {
    const search = new URLSearchParams(query).toString();
    let res: Response;
    try {
      res = await fetch(`${url}${path}${search ? `?${search}` : ""}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new PlatformError(503, "memory_unavailable", `memory service is ${reason}`);
    }
    const body = (await res.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
    if (res.ok && body) return body;
    // memory의 401을 그대로 돌려주면 관리 화면이 로그아웃된다.
    if (res.status === 401) throw new PlatformError(502, "memory_key_mismatch", "memory service refused the gateway's key: gateway/memory_api_key must equal memory/api_key");
    const refused = res.status >= 400 && res.status < 500;
    throw new PlatformError(refused ? res.status : 502, body?.error?.code ?? "memory_error", body?.error?.message ?? `memory service answered ${res.status}`);
  };

  const wiki = (user: string | undefined) => {
    if (!user || !isValidUserId(user)) throw badRequest("user must be a valid user id");
    return `/wiki/${encodeURIComponent(user)}`;
  };

  /** 메모리를 가진 사용자와 사용량 */
  app.get("/memory", async () => get("/wikis"));

  app.get<{ Querystring: { user?: string } }>("/memory/notes", async (req) => get(`${wiki(req.query.user)}/notes`));

  app.get<{ Querystring: { user?: string; path?: string } }>("/memory/note", async (req) => get(`${wiki(req.query.user)}/note`, { path: req.query.path ?? "" }));

  app.get<{ Querystring: { user?: string; q?: string } }>("/memory/search", async (req) =>
    get(`${wiki(req.query.user)}/search`, { q: req.query.q ?? "", limit: "20" }),
  );
}
