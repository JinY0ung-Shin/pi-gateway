import type { FastifyInstance } from "fastify";
import { probeLlmServer } from "../agent/runtime.js";
import type { AdminContext } from "./context.js";

/** check가 끝나는지와 걸린 시간 */
async function timed(check: () => Promise<unknown>): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const started = Date.now();
  try {
    await check();
    return { ok: true, durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

/** LLM 서버마다 모델 목록을 물어 연결·인증과 설정한 모델이 서버에 있는지 본다 */
function checkLlm(ctx: AdminContext) {
  return Promise.all(
    (ctx.llm.current()?.settings.servers ?? []).map(async (s) => {
      const probe = await probeLlmServer(s, 5_000);
      const listed = new Set(probe.models?.map((m) => m.id));
      return {
        id: s.id,
        ok: probe.ok,
        durationMs: probe.durationMs,
        ...(probe.error ? { error: probe.error } : {}),
        models: s.models.length,
        missingModels: probe.ok ? s.models.filter((m) => !listed.has(m.id)).map((m) => m.id) : [],
      };
    }),
  );
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get("/status", async () => {
    let items: Awaited<ReturnType<AdminContext["sandboxes"]>> = [];
    const [llm, broker, sandboxd] = await Promise.all([
      checkLlm(ctx),
      timed(() => ctx.mcp.assertBrokerReachable()),
      timed(async () => {
        items = await ctx.sandboxes();
      }),
    ]);
    const memory = process.memoryUsage();
    const plugins = ctx.plugins.listPlugins();
    const live = ctx.prompts.live();
    return {
      stats: ctx.stats(),
      activeTurns: ctx.activeTurns(),
      services: { llm, broker, sandboxd },
      sandboxes: { items, ...(sandboxd.error ? { error: sandboxd.error } : {}) },
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
      plugins: { installed: plugins.length, enabled: plugins.filter((p) => p.enabled).length },
      prompt: { name: live.name, version: live.version, isDefault: live.isDefault },
      tools: ctx.toolStats.summary(),
      turns: ctx.toolStats.turns(),
      users: ctx.toolStats.users(),
    };
  });
}
