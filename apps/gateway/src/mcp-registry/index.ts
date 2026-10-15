import { platformLogger } from "../admin/logger.js";
import type { GatewayConfig } from "../config.js";
import type { McpRegistry } from "../contracts.js";
import type { Db } from "../db.js";
import { McpRegistryService } from "./service.js";

export { BrokerClient, BrokerError } from "./broker-client.js";
export type { McpServerEntry, McpServerList, McpStore } from "./service.js";
export { McpRegistryService, mergeWithBaseline, policyProblems } from "./service.js";

/**
 * MCP 서버 목록. 반환 객체는 McpRegistry(세션용)이면서 관리 API용 메서드도 가진다.
 * sandbox 서버는 gateway DB, broker 서버는 broker에 있으므로 여러 인스턴스를 만들어도 결과가 같다.
 */
export function createMcpRegistry(db: Db, config: GatewayConfig): McpRegistryService {
  return new McpRegistryService(db, config, platformLogger(config, "mcp-registry"));
}

export function isMcpRegistryService(registry: McpRegistry): registry is McpRegistryService {
  return registry instanceof McpRegistryService;
}
