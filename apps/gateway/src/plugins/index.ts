import { platformLogger } from "../admin/logger.js";
import type { GatewayConfig } from "../config.js";
import type { PluginResources } from "../contracts.js";
import type { Db } from "../db.js";
import { McpRegistryService } from "../mcp-registry/service.js";
import { PluginService } from "./service.js";

export type { CatalogEntry, MarketplaceView, PluginSettings, PluginView } from "./service.js";
export { PluginService, pluginDataDir } from "./service.js";

/**
 * 설치된 plugin의 skill·command·agent를 세션에 제공한다. 반환 객체는 관리 API용 메서드(marketplace,
 * 설치·제거)도 가진다. 상태(설치 목록, revision)는 DB에 있으므로 여러 인스턴스가 같은 결과를 본다.
 */
export function createPluginResources(db: Db, config: GatewayConfig): PluginService {
  const registry = new McpRegistryService(db, config, platformLogger(config, "mcp-registry"));
  return new PluginService(db, config, { registry, log: platformLogger(config, "plugins") });
}

export function isPluginService(resources: PluginResources): resources is PluginService {
  return resources instanceof PluginService;
}
