import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { createSubagentTools, subagentTools } from "../agent/subagents.js";
import type { ToolSessionContext } from "../tools/provider.js";
import { createAskUserToolProvider } from "../tools/providers/ask-user.js";
import { createRequestAdminToolProvider } from "../tools/providers/request-admin.js";
import { createSandboxToolProvider } from "../tools/providers/sandbox.js";
import type { AdminContext } from "./context.js";
import { PlatformError } from "./errors.js";

/**
 * 기본 도구 정의 (모델에게 넘어가는 이름·설명·입력 스키마)와 켜고 끄기. 세션과 같은 provider로 만들지만
 * 실행하지 않으므로 세션 context는 비워 둔다. Agent·SendMessage는 켜진 plugin에 agent가 있을 때만 생긴다.
 * agents: plugin agent마다 실제로 받는 기본 도구 (꺼진 도구는 빠진다). MCP 도구는 세션마다 달라 이름만 따로 적는다
 * (frontmatter `tools`가 없으면 세션의 MCP 도구 전부).
 */
export function registerToolRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const definitions = async () => {
    const unused = {} as ToolSessionContext;
    const agents = ctx.plugins.agents();
    const sandbox = await createSandboxToolProvider().createTools(unused);
    const gateway = [
      ...(await createAskUserToolProvider().createTools(unused)),
      ...(await createRequestAdminToolProvider(ctx.adminRequests).createTools(unused)),
      ...createSubagentTools({ agents, tools: [], dir: "", open: () => Promise.reject(new Error("not used")) }),
    ];
    return { agents, sandbox, gateway };
  };

  app.get("/tools", async () => {
    const { agents, sandbox, gateway } = await definitions();
    const disabled = ctx.toolSettings.disabled();
    const view = (runsIn: "sandbox" | "gateway") => (t: ToolDefinition) => ({
      name: t.name,
      runsIn,
      enabled: !disabled.has(t.name),
      description: t.description,
      ...(t.promptGuidelines?.length ? { promptGuidelines: t.promptGuidelines } : {}),
      parameters: t.parameters,
    });
    const enabledSandbox = sandbox.filter((t) => !disabled.has(t.name));
    return {
      tools: [...sandbox.map(view("sandbox")), ...gateway.map(view("gateway"))],
      agents: agents.map((a) => ({
        name: a.name,
        tools: subagentTools(a, enabledSandbox).map((t) => t.name),
        mcp: a.tools ? a.tools.filter((n) => n.startsWith("mcp__")) : "all",
      })),
    };
  });

  const setEnabled = async (name: string, enabled: boolean) => {
    const { sandbox, gateway } = await definitions();
    if (![...sandbox, ...gateway].some((t) => t.name === name)) throw new PlatformError(404, "tool_not_found", `tool ${name} not found`);
    ctx.toolSettings.setEnabled(name, enabled);
    ctx.log.info({ tool: name, enabled }, "tool setting updated");
    return { name, enabled };
  };
  app.post<{ Params: { name: string } }>("/tools/:name/enable", async (req) => setEnabled(req.params.name, true));
  app.post<{ Params: { name: string } }>("/tools/:name/disable", async (req) => setEnabled(req.params.name, false));
}
