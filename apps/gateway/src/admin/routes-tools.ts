import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { createSubagentTools, subagentTools } from "../agent/subagents.js";
import type { ToolSessionContext } from "../tools/provider.js";
import { createAskUserToolProvider } from "../tools/providers/ask-user.js";
import { createSandboxToolProvider } from "../tools/providers/sandbox.js";
import type { AdminContext } from "./context.js";

/**
 * 기본 도구 정의 (모델에게 넘어가는 이름·설명·입력 스키마). 세션과 같은 provider로 만들지만
 * 실행하지 않으므로 세션 context는 비워 둔다. Agent·SendMessage는 켜진 plugin에 agent가 있을 때만 생긴다.
 * agents: plugin agent마다 실제로 받는 기본 도구. MCP 도구는 세션마다 달라 이름만 따로 적는다
 * (frontmatter `tools`가 없으면 세션의 MCP 도구 전부).
 */
export function registerToolRoutes(app: FastifyInstance, ctx: AdminContext): void {
  app.get("/tools", async () => {
    const unused = {} as ToolSessionContext;
    const view = (runsIn: "sandbox" | "gateway") => (t: ToolDefinition) => ({
      name: t.name,
      runsIn,
      description: t.description,
      ...(t.promptGuidelines?.length ? { promptGuidelines: t.promptGuidelines } : {}),
      parameters: t.parameters,
    });
    const agents = ctx.plugins.agents();
    const subagents = createSubagentTools({
      agents,
      tools: [],
      dir: "",
      open: () => Promise.reject(new Error("not used")),
    });
    const sandbox = await createSandboxToolProvider().createTools(unused);
    const askUser = await createAskUserToolProvider().createTools(unused);
    return {
      tools: [...sandbox.map(view("sandbox")), ...askUser.map(view("gateway")), ...subagents.map(view("gateway"))],
      agents: agents.map((a) => ({
        name: a.name,
        tools: subagentTools(a, sandbox).map((t) => t.name),
        mcp: a.tools ? a.tools.filter((n) => n.startsWith("mcp__")) : "all",
      })),
    };
  });
}
