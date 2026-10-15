import type { GatewayConfig } from "../config.js";
import type { PromptService } from "../contracts.js";
import type { Db } from "../db.js";
import { PromptManager } from "./service.js";

export { DEFAULT_SYSTEM_PROMPT } from "./default-prompt.js";
export { PROMPT_VARIABLES } from "./render.js";
export type { LivePrompt, PromptDeployment, PromptDetail, PromptSummary, PromptVersion } from "./service.js";
export { PromptManager };

/**
 * 시스템 프롬프트 서비스. 반환 객체는 PromptService(세션용)이면서 관리 API용 메서드도 가진다.
 * 상태는 모두 DB에 있으므로 여러 인스턴스를 만들어도 결과가 같다.
 */
export function createPromptService(db: Db, config: GatewayConfig): PromptManager {
  return new PromptManager(db, config);
}

export function isPromptManager(service: PromptService): service is PromptManager {
  return service instanceof PromptManager;
}
