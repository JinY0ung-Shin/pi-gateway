import type { FastifyInstance } from "fastify";
import type { ToolCatalogEntry } from "../contracts.js";
import { MCP_WILDCARD } from "../tool-policy/index.js";
import { actorOf } from "./auth.js";
import type { AdminContext } from "./context.js";
import { badRequest, notFound, PlatformError } from "./errors.js";

type NameParams = { Params: { name: string } };

export interface ToolView extends ToolCatalogEntry {
  enabled: boolean;
  /** 관리자가 직접 정했는지 (false면 기본값) */
  explicit: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export function registerToolRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const policy = ctx.toolPolicy;

  const catalog = async (): Promise<ToolCatalogEntry[] | null> => (ctx.deps.tools ? ctx.deps.tools.list() : null);

  const view = (entry: ToolCatalogEntry): ToolView => {
    const setting = policy.get(entry.name);
    return {
      ...entry,
      enabled: policy.isEnabled(entry, "_admin"),
      explicit: setting !== undefined,
      updatedBy: setting?.updatedBy ?? null,
      updatedAt: setting?.updatedAt ?? null,
    };
  };

  /** 카탈로그에 없지만 MCP 서버 대표 이름이면 동적 항목으로 다룬다 (broker가 잠시 안 보일 때 등). */
  const findEntry = (entries: ToolCatalogEntry[], name: string): ToolCatalogEntry | undefined => {
    const found = entries.find((e) => e.name === name);
    if (found) return found;
    if (MCP_WILDCARD.test(name)) {
      return { name, description: "MCP 서버의 모든 도구", provider: "mcp", runsIn: "broker", enabledByDefault: true, dynamic: true };
    }
    return undefined;
  };

  app.get("/tools", async () => {
    const entries = await catalog();
    const names = new Set((entries ?? []).map((e) => e.name));
    return {
      catalogAvailable: entries !== null,
      revision: policy.revision(),
      tools: (entries ?? []).map(view),
      /** 카탈로그에 더 이상 없는 도구에 남은 설정 */
      orphans: policy.list().filter((s) => !names.has(s.name)),
    };
  });

  app.put<NameParams & { Body: { enabled?: unknown } }>("/tools/:name", async (req) => {
    if (typeof req.body?.enabled !== "boolean") throw badRequest("body must be { enabled: boolean }");
    const entry = findEntry((await catalog()) ?? [], req.params.name);
    if (!entry) throw notFound(`tool '${req.params.name}' is not in the catalog`);
    if (entry.required) throw new PlatformError(409, "required", `tool '${entry.name}' is required and cannot be turned off`);
    policy.set(entry.name, req.body.enabled, actorOf(req));
    return view(entry);
  });

  app.delete<NameParams>("/tools/:name", async (req) => {
    const entry = findEntry((await catalog()) ?? [], req.params.name);
    const removed = policy.reset(req.params.name);
    if (!entry && !removed) throw notFound(`tool '${req.params.name}' has no setting`);
    return entry ? view(entry) : { name: req.params.name, reset: removed };
  });
}
