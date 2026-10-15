import type { AdminDeps } from "../contracts.js";
import { createMcpRegistry, isMcpRegistryService } from "../mcp-registry/index.js";
import type { McpRegistryService } from "../mcp-registry/service.js";
import { isPluginService, PluginService } from "../plugins/index.js";
import { isPromptManager, PromptManager } from "../prompts/index.js";
import { AdminAuth } from "./auth.js";
import { type PlatformLogger, platformLogger } from "./logger.js";

export interface AdminContext {
  deps: AdminDeps;
  auth: AdminAuth;
  prompts: PromptManager;
  plugins: PluginService;
  mcp: McpRegistryService;
  log: PlatformLogger;
}

/**
 * deps에 들어온 서비스가 이 레인의 구현이면 그대로 쓰고, 아니면(임시 구현 등) DB로 새로 만든다.
 * 모든 상태가 DB에 있으므로 새로 만들어도 세션 쪽과 같은 내용을 본다.
 */
export function createAdminContext(deps: AdminDeps): AdminContext {
  const log = platformLogger(deps.config, "admin");
  const mcp = isMcpRegistryService(deps.mcp) ? deps.mcp : createMcpRegistry(deps.db, deps.config);
  return {
    deps,
    auth: new AdminAuth(deps.db, deps.config),
    prompts: isPromptManager(deps.prompts) ? deps.prompts : new PromptManager(deps.db, deps.config),
    plugins: isPluginService(deps.plugins)
      ? deps.plugins
      : new PluginService(deps.db, deps.config, { registry: mcp, log: platformLogger(deps.config, "plugins") }),
    mcp,
    log,
  };
}
