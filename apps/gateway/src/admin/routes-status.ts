import type { FastifyInstance } from "fastify";
import type { AdminContext } from "./context.js";

export function registerStatusRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get("/status", async () => {
    let sandboxes: { items: Awaited<ReturnType<AdminContext["sandboxes"]>>; error?: string };
    try {
      sandboxes = { items: await ctx.sandboxes() };
    } catch (error) {
      sandboxes = { items: [], error: error instanceof Error ? error.message : String(error) };
    }
    const memory = process.memoryUsage();
    const plugins = ctx.plugins.listPlugins();
    const live = ctx.prompts.live();
    return {
      stats: ctx.stats(),
      sandboxes,
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
      },
      plugins: { installed: plugins.length, enabled: plugins.filter((p) => p.enabled).length },
      prompt: { name: live.name, version: live.version, isDefault: live.isDefault },
    };
  });
}
