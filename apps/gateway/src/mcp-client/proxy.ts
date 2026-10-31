import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * MCP 서버의 도구는 모델에게 하나씩 선언하지 않고 고정된 두 도구로 쓴다.
 * plugin MCP도 같다: skill에 적힌 이름은 검색 없이 mcp_call로 바로 부르면 된다.
 * - mcp_search: 도구를 찾아 schema를 결과로 돌려준다.
 * - mcp_call: 이름과 인자로 도구를 실행한다.
 * 선언 목록이 세션 내내 바뀌지 않아 prefix cache가 깨지지 않고, 모델이 부르는 이름은 늘 선언된 것이라
 * tool-call parser가 선언되지 않은 이름을 버리는 모델 서버(SGLang 등)에서도 동작한다.
 * 도구 자체는 숨긴 선언으로 등록해 두어, 서버가 넘겨 주면 이름으로 바로 불러도 실행된다.
 */

export const MCP_SEARCH_TOOL = "mcp_search";
export const MCP_CALL_TOOL = "mcp_call";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export interface ProxiedServer {
  id: string;
  displayName?: string;
  description?: string;
}

/** 소문자 단어. 한글은 조사가 붙어도 맞도록 두 글자씩 자른다 (`결함을` → `결함`, `함을`). */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  for (const word of words) {
    if (!word) continue;
    if (!/\p{Script=Hangul}/u.test(word) || word.length <= 2) {
      terms.push(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  }
  return terms;
}

/** 도구 이름·설명·인자 이름과 설명, 서버 이름과 설명을 검색 대상으로 쓴다. */
function documentText(tool: ToolDefinition, server: ProxiedServer | undefined): string {
  const parts = [tool.name.replaceAll("_", " "), tool.description, server?.displayName ?? "", server?.description ?? ""];
  const properties = (tool.parameters as { properties?: Record<string, { description?: unknown }> }).properties ?? {};
  for (const [name, schema] of Object.entries(properties)) {
    parts.push(name);
    if (typeof schema?.description === "string") parts.push(schema.description);
  }
  return parts.join(" ");
}

/** Okapi BM25 (k1 1.2, b 0.75). 점수가 같으면 원래 순서를 지킨다. */
function rank(query: string, documents: string[], limit: number): number[] {
  const queryTerms = [...new Set(searchTerms(query))];
  if (queryTerms.length === 0) return [];
  const counts = documents.map((text) => {
    const m = new Map<string, number>();
    for (const term of searchTerms(text)) m.set(term, (m.get(term) ?? 0) + 1);
    return m;
  });
  const lengths = counts.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const average = lengths.reduce((a, b) => a + b, 0) / documents.length || 1;
  const scored: { index: number; score: number }[] = [];
  counts.forEach((m, index) => {
    let score = 0;
    for (const term of queryTerms) {
      const count = m.get(term);
      if (!count) continue;
      const frequency = counts.filter((c) => c.has(term)).length;
      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      score += (idf * (count * 2.2)) / (count + 1.2 * (0.25 + (0.75 * lengths[index]!) / average));
    }
    if (score > 0) scored.push({ index, score });
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.index);
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

/** McpConnectionSet이 만든 도구의 label은 `<server id>/<MCP 도구 이름>`이다 (도구 이름은 64자에서 잘릴 수 있다). */
const serverOf = (tool: ToolDefinition) => tool.label.slice(0, tool.label.indexOf("/"));
const mcpNameOf = (tool: ToolDefinition) => tool.label.slice(tool.label.indexOf("/") + 1).replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * 정확한 이름이 없을 때 다른 형식의 이름을 도구로 바꾼다. skill은 Claude Code 형식
 * (`mcp__plugin_<plugin>_<server>__<tool>`)이나 MCP 도구 이름만 적기도 한다.
 * 이름이 `__<MCP 도구 이름>`으로 끝나는 도구를 찾고, 여럿이면 이름에 서버 id가 들어 있는 것으로 좁힌다.
 */
function resolveAlias(name: string, tools: ToolDefinition[]): ToolDefinition[] {
  const matches = tools.filter((t) => name === mcpNameOf(t) || name.endsWith(`__${mcpNameOf(t)}`));
  if (matches.length <= 1) return matches;
  const narrowed = matches.filter((t) => name.includes(serverOf(t)));
  return narrowed.length > 0 ? narrowed : matches;
}

/** 세션을 만들 때 도구 목록을 못 받은 서버를 나중에 다시 받는다 (McpConnectionSet). */
export interface McpRecovery {
  /** 목록을 못 받은 서버의 id */
  readonly failed: ReadonlySet<string>;
  /** 새로 받은 도구 정의 (없거나 아직 다시 물어볼 때가 아니면 빈 목록) */
  retryFailed(signal?: AbortSignal): Promise<ToolDefinition[]>;
}

/**
 * tools: MCP 서버들의 도구 정의. 돌려준 목록에 원래 도구도 들어 있다.
 * recovery가 있으면 목록을 못 받은 서버도 서비스 목록에 넣어 두고, mcp_search와 (모르는 이름의) mcp_call이
 * 그 서버를 다시 물어본다. 선언은 세션 내내 그대로다 (prefix cache).
 */
export function createMcpProxyTools(tools: ToolDefinition[], servers: ProxiedServer[], recovery?: McpRecovery): ToolDefinition[] {
  const failed = recovery?.failed ?? new Set<string>();
  if (tools.length === 0 && failed.size === 0) return [];
  const hidden = tools.map((t) => t.name);
  const known = [...tools];
  const byName = new Map(known.map((t) => [t.name, t]));
  const serverById = new Map(servers.map((s) => [s.id, s]));
  const documents = known.map((t) => documentText(t, serverById.get(serverOf(t))));
  const services = servers
    .filter((s) => failed.has(s.id) || known.some((t) => serverOf(t) === s.id))
    .map((s) => `- ${s.id}${s.displayName && s.displayName !== s.id ? ` (${s.displayName})` : ""}${s.description ? `: ${s.description.split("\n")[0]}` : ""}`)
    .join("\n");
  const recover = async (signal: AbortSignal | undefined) => {
    for (const tool of (await recovery?.retryFailed(signal)) ?? []) {
      known.push(tool);
      byName.set(tool.name, tool);
      documents.push(documentText(tool, serverById.get(serverOf(tool))));
    }
  };

  const search: ToolDefinition = {
    name: MCP_SEARCH_TOOL,
    label: "MCP search",
    description: `Find tools of the connected services below and get their parameter schemas. Then run a tool with ${MCP_CALL_TOOL}.\n\nConnected services:\n${services}`,
    parameters: Type.Object({
      query: Type.String({ description: "What you want to do, or the service name. Any language." }),
      limit: Type.Optional(Type.Number({ description: `Maximum number of tools to return. Default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}.` })),
    }),
    // 도구 목록에서 원래 도구의 선언은 빼고 실행만 되게 둔다.
    prepareLoadout: () => ({ hiddenDeclarations: hidden }),
    async execute(_id, params, signal) {
      const { query, limit } = params as { query: string; limit?: number };
      const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
      await recover(signal);
      const found = rank(query, documents, n).map((i) => known[i]!);
      if (found.length === 0) return text(`No tools matched "${query}". Try other words or a service name from the list.`);
      const blocks = found.map((t) => `## ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters)}`);
      return text(`${blocks.join("\n\n")}\n\nRun one with ${MCP_CALL_TOOL} {"name": "<tool name>", "arguments": {...}}.`);
    },
  };

  const find = (name: string) => {
    const tool = byName.get(name);
    if (tool) return tool;
    const aliases = resolveAlias(name, known);
    if (aliases.length > 1) throw new Error(`'${name}' matches several tools: ${aliases.map((t) => t.name).join(", ")}. Call one of them.`);
    return aliases[0];
  };

  const call: ToolDefinition = {
    name: MCP_CALL_TOOL,
    label: "MCP call",
    description: `Run a tool of a connected service by its exact name, with arguments that match its parameter schema. When a skill or the user already names the tool, call it directly; otherwise find it with ${MCP_SEARCH_TOOL} first.`,
    parameters: Type.Object({
      name: Type.String({ description: "Tool name, for example mcp__<service>__<tool>." }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for the tool." })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { name, arguments: args = {} } = params as { name: string; arguments?: Record<string, unknown> };
      let tool = find(name);
      if (!tool) {
        await recover(signal);
        tool = find(name);
      }
      if (!tool) throw new Error(`Unknown tool '${name}'. Find the exact name with ${MCP_SEARCH_TOOL}.`);
      let validated: Record<string, unknown>;
      try {
        validated = validateToolArguments(tool as never, { type: "toolCall", id: toolCallId, name: tool.name, arguments: args as never });
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}\nParameters of ${tool.name}: ${JSON.stringify(tool.parameters)}`);
      }
      return tool.execute(toolCallId, validated as never, signal, onUpdate, ctx);
    },
  };

  return [search, call, ...tools];
}
