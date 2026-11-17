import { readSecret } from "@pi-gateway/shared";

/** memory 서비스 설정. 포트는 고정이고, 시작할 때 알아야 하는 것만 환경변수에서 읽는다. */
export interface MemoryConfig {
  host: string;
  port: number;
  /** wiki 파일이 놓이는 곳 (`<dataDir>/wikis/<owner key>/`) */
  dataDir: string;
  /** 부르는 쪽(mcp-broker, BFF)이 Bearer로 보내는 키 */
  apiKey: string;
}

export const MEMORY_PORT = 7090;

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const apiKey = readSecret(env, "MEMORY_API_KEY");
  if (!apiKey || apiKey.length < 32) throw new Error("MEMORY_API_KEY (or MEMORY_API_KEY_FILE) is required and must be at least 32 characters");
  return { host: "0.0.0.0", port: MEMORY_PORT, dataDir: env.DATA_DIR ?? "/data", apiKey };
}
