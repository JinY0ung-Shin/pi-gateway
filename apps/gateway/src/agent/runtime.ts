import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig, LlmModelConfig } from "../config.js";

/**
 * 모든 세션이 공유하는 ModelRuntime.
 * - 자격 증명은 메모리에만 둔다 (auth.json을 만들지 않는다).
 * - models.json을 읽지 않고, 네트워크로 모델 카탈로그를 받지 않는다.
 * - API 키는 config 값 확장(`!cmd`, `$VAR`)을 거치지 않도록 runtime key로 넣는다.
 */

/** vLLM 같은 OpenAI 호환 서버에서 안전한 기본값. LLM_COMPAT으로 덮어쓸 수 있다. */
export const DEFAULT_OPENAI_COMPAT: Record<string, unknown> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  supportsMidConvoSystemMessages: false,
  supportsStrictMode: false,
};

export interface GatewayModels {
  runtime: ModelRuntime;
  providerId: string;
  get(id: string): Model<Api> | undefined;
  config(id: string): LlmModelConfig | undefined;
}

export async function createModelRuntime(config: GatewayConfig): Promise<GatewayModels> {
  // pi는 PI_OFFLINE이 있으면 모델 카탈로그·도구 다운로드 등 네트워크 접근을 하지 않는다.
  process.env.PI_OFFLINE ??= "1";
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { llm } = config;
  const compat = llm.api === "openai-completions" ? { ...DEFAULT_OPENAI_COMPAT, ...llm.compat } : { ...llm.compat };
  runtime.registerProvider(llm.providerId, {
    name: llm.providerId,
    baseUrl: llm.baseUrl,
    api: llm.api,
    ...(Object.keys(llm.headers).length > 0 ? { headers: llm.headers } : {}),
    models: llm.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: llm.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      ...(Object.keys(compat).length > 0 ? { compat: compat as never } : {}),
    })),
  });
  await runtime.setRuntimeApiKey(llm.providerId, llm.apiKey);
  for (const m of llm.models) {
    if (!runtime.getModel(llm.providerId, m.id)) throw new Error(`model ${m.id} could not be registered with pi`);
  }
  return {
    runtime,
    providerId: llm.providerId,
    get: (id) => runtime.getModel(llm.providerId, id),
    config: (id) => llm.models.find((m) => m.id === id),
  };
}
