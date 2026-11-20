import { errorBody, isValidUserId } from "@pi-gateway/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import { HASH_PATTERN, WikiError, type WikiErrorCode, type WikiStore } from "./wiki.js";

/**
 * 프로그램용 API (`/wiki/<owner>/…`, JSON). 같은 스택의 BFF가 자기가 허락한 주인의 wiki를 다룬다.
 * `/wikis`는 모든 wiki의 주인과 사용량이다 (gateway 관리 화면의 목록).
 * MCP 도구(tools.ts)는 모델이 읽는 글을 gateway가 자르는 크기 아래로 나눠 주지만, 프로그램은 전부를 받아야 한다:
 * 전체 목록, 노트 전문, 긴 노트의 통째 교체, wiki 전체 삭제. 저장소와 규칙(경로, hash, 한도)은 같다.
 */

const STATUS: Record<WikiErrorCode, number> = {
  invalid_path: 400,
  invalid_content: 400,
  invalid_offset: 400,
  invalid_query: 400,
  no_match: 400,
  ambiguous: 400,
  no_change: 400,
  not_found: 404,
  exists: 409,
  stale: 409,
  too_large: 413,
  wiki_full: 507,
};

const NoteQuery = z.object({ path: z.string() });
const ListQuery = z.object({ prefix: z.string().optional() });
const NoQuery = z.strictObject({});
const SearchQuery = z.object({ q: z.string().max(500), limit: z.coerce.number().int().min(1).max(20).optional(), prefix: z.string().optional() });
const Hash = z.string().regex(HASH_PATTERN);
const DeleteQuery = z.object({ path: z.string(), hash: Hash });
const PutBody = z.object({ path: z.string(), content: z.string(), hash: Hash.optional() });

export function registerWikiRoutes(app: FastifyInstance, store: WikiStore, log: Logger): void {
  /** 주인을 확인하고 `run`의 결과를 JSON으로 보낸다. 거절은 그 code와 맞는 상태로, 그 밖의 실패는 500으로 답한다. */
  const route = (run: (owner: string, req: FastifyRequest) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { owner } = req.params as { owner: string };
    if (!isValidUserId(owner)) return reply.code(400).send(errorBody("invalid_owner", "the owner in the URL is not a valid user id"));
    try {
      return reply.header("content-type", "application/json").send(JSON.stringify(await run(owner, req)));
    } catch (err) {
      if (err instanceof WikiError) return reply.code(STATUS[err.code]).send(errorBody(err.code, err.message));
      if (err instanceof z.ZodError || err instanceof SyntaxError) return reply.code(400).send(errorBody("invalid_request", "the request does not have the expected fields"));
      log.error({ err }, "wiki request failed");
      return reply.code(500).send(errorBody("internal", "the memory store failed"));
    }
  };

  app.get("/wikis", async () => ({ wikis: await store.wikis() }));

  app.get("/wiki/:owner/notes", route(async (owner, req) => ({ notes: await store.list(owner, ListQuery.parse(req.query).prefix) })));

  app.get("/wiki/:owner/note", route((owner, req) => store.readWhole(owner, NoteQuery.parse(req.query).path)));

  // 본문은 문자열로 들어온다 (app.ts가 MCP를 위해 파서를 바꿔 둔다).
  app.put(
    "/wiki/:owner/note",
    route((owner, req) => {
      const { path, content, hash } = PutBody.parse(JSON.parse(typeof req.body === "string" ? req.body : ""));
      return store.write(owner, path, content, hash, true);
    }),
  );

  app.delete(
    "/wiki/:owner/note",
    route((owner, req) => {
      const { path, hash } = DeleteQuery.parse(req.query);
      return store.delete(owner, path, hash);
    }),
  );

  app.get(
    "/wiki/:owner/search",
    route((owner, req) => {
      const { q, limit, prefix } = SearchQuery.parse(req.query);
      return store.search(owner, q, limit, prefix);
    }),
  );

  app.delete(
    "/wiki/:owner",
    route(async (owner, req) => {
      // query가 붙은 요청은 `/note`를 빠뜨린 노트 하나의 삭제일 수 있다. 전부 지우지 않고 거절한다.
      NoQuery.parse(req.query);
      await store.deleteAll(owner);
      return { deleted: true };
    }),
  );
}
