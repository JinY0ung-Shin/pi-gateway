import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { type Db, migrate } from "../db.js";

/**
 * 모든 세션이 공유하는 ModelRuntime과 LLM 연결 설정.
 * - 설정은 관리 화면에서 바꾸고 gateway DB에 저장한다. 바꾸면 바로 provider를 다시 등록한다.
 *   메모리의 세션은 다음 턴에 새 설정으로 다시 연다 (revision이 바뀌었는지 SessionHub가 본다).
 * - 자격 증명은 메모리에만 둔다 (auth.json을 만들지 않는다).
 * - models.json을 읽지 않고, 네트워크로 모델 카탈로그를 받지 않는다.
 * - API 키는 config 값 확장(`!cmd`, `$VAR`)을 거치지 않도록 runtime key로 넣는다.
 */

export const LlmModelConfig = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(["text", "image"])).default(["text"]),
});
export type LlmModelConfig = z.infer<typeof LlmModelConfig>;

export const LlmSettings = z
  .object({
    /** openai-completions (/v1/chat/completions) | anthropic-messages (/v1/messages) */
    api: z.enum(["openai-completions", "anthropic-messages"]),
    baseUrl: z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, "")),
    /** 빈 값 = 키가 없는 엔드포인트 */
    apiKey: z.string(),
    /** 요청마다 붙일 헤더 */
    headers: z.record(z.string(), z.string()).default({}),
    /** pi 모델 compat 덮어쓰기. openai-completions면 vLLM용 기본값 위에 합친다. */
    compat: z.record(z.string(), z.unknown()).default({}),
    models: z.array(LlmModelConfig).min(1),
    defaultModel: z.string().min(1),
  })
  .superRefine((s, ctx) => {
    const ids = s.models.map((m) => m.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["models"], message: "model ids must be unique" });
    if (!ids.includes(s.defaultModel)) ctx.addIssue({ code: "custom", path: ["defaultModel"], message: "defaultModel must be one of models" });
  });
export type LlmSettings = z.infer<typeof LlmSettings>;

/** vLLM 같은 OpenAI 호환 서버에서 안전한 기본값. compat으로 덮어쓸 수 있다. */
export const DEFAULT_OPENAI_COMPAT: Record<string, unknown> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
  supportsMidConvoSystemMessages: false,
  supportsStrictMode: false,
};

/** pi provider id (모델 id 앞의 이름, `/v1/models`의 owned_by) */
export const PROVIDER_ID = "upstream";

export interface LlmSettingsRecord {
  settings: LlmSettings;
  updatedAt: string;
  updatedBy: string;
}

export interface GatewayModels {
  runtime: ModelRuntime;
  providerId: string;
  get(id: string): Model<Api> | undefined;
  config(id: string): LlmModelConfig | undefined;
  list(): LlmModelConfig[];
  /** 설정되지 않았으면 undefined */
  defaultModel(): string | undefined;
  /** 설정이 바뀔 때마다 1씩 오른다 */
  revision(): number;
  current(): LlmSettingsRecord | null;
  /** 검증하고 provider를 다시 등록한 뒤 저장한다. 등록에 실패하면 이전 설정으로 되돌리고 던진다. */
  update(settings: LlmSettings, actor: string): Promise<LlmSettingsRecord>;
}

const MIGRATIONS = [
  `CREATE TABLE llm_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     settings_json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   )`,
];

async function register(runtime: ModelRuntime, s: LlmSettings): Promise<void> {
  const compat = s.api === "openai-completions" ? { ...DEFAULT_OPENAI_COMPAT, ...s.compat } : { ...s.compat };
  runtime.unregisterProvider(PROVIDER_ID);
  runtime.registerProvider(PROVIDER_ID, {
    name: PROVIDER_ID,
    baseUrl: s.baseUrl,
    api: s.api,
    ...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
    models: s.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: s.api,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      ...(Object.keys(compat).length > 0 ? { compat: compat as never } : {}),
    })),
  });
  // 키가 없는 엔드포인트에도 pi는 키 값을 요구한다
  await runtime.setRuntimeApiKey(PROVIDER_ID, s.apiKey || "not-needed");
  for (const m of s.models) {
    if (!runtime.getModel(PROVIDER_ID, m.id)) throw new Error(`model ${m.id} could not be registered with pi`);
  }
}

export async function createModelRuntime(db: Db): Promise<GatewayModels> {
  // pi는 PI_OFFLINE이 있으면 모델 카탈로그·도구 다운로드 등 네트워크 접근을 하지 않는다.
  process.env.PI_OFFLINE ??= "1";
  migrate(db, "llm", MIGRATIONS);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  const row = db.prepare("SELECT settings_json, updated_at, updated_by FROM llm_settings WHERE id = 1").get() as
    | { settings_json: string; updated_at: string; updated_by: string }
    | undefined;
  let current: LlmSettingsRecord | null = row
    ? { settings: LlmSettings.parse(JSON.parse(row.settings_json)), updatedAt: row.updated_at, updatedBy: row.updated_by }
    : null;
  if (current) await register(runtime, current.settings);
  let revision = 0;

  const save = db.prepare(
    `INSERT INTO llm_settings (id, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  );

  return {
    runtime,
    providerId: PROVIDER_ID,
    get: (id) => (current?.settings.models.some((m) => m.id === id) ? runtime.getModel(PROVIDER_ID, id) : undefined),
    config: (id) => current?.settings.models.find((m) => m.id === id),
    list: () => current?.settings.models ?? [],
    defaultModel: () => current?.settings.defaultModel,
    revision: () => revision,
    current: () => current,
    async update(input, actor) {
      const settings = LlmSettings.parse(input);
      try {
        await register(runtime, settings);
      } catch (err) {
        if (current) await register(runtime, current.settings);
        else runtime.unregisterProvider(PROVIDER_ID);
        throw err;
      }
      const next = { settings, updatedAt: new Date().toISOString(), updatedBy: actor };
      save.run(JSON.stringify(settings), next.updatedAt, actor);
      current = next;
      revision++;
      return next;
    },
  };
}
