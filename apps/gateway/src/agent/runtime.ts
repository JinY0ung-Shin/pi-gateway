import type { Api, ClassifierChoiceAnswer, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ChoiceQuestion } from "../contracts.js";
import { type Db, migrate } from "../db.js";

/**
 * 모든 세션이 공유하는 ModelRuntime과 LLM 연결 설정.
 * - 설정은 관리 화면에서 바꾸고 gateway DB에 저장한다. 바꾸면 바로 provider를 다시 등록한다.
 *   메모리의 세션은 다음 턴에 새 설정으로 다시 연다 (revision이 바뀌었는지 SessionHub가 본다).
 * - LLM 서버마다 pi provider 하나로 등록한다 (provider id = 서버 id). 모델 id는 서버 전체에서 겹치지 않는다.
 * - 티어(eagle·falcon·swift)는 모델 하나를 가리키는 고정 이름이다. 가리키는 모델을 바꾸면 그 티어의 세션도 다음 턴부터 새 모델로 돈다.
 * - System One은 mcp_search가 도구를 고를 때 묻는 decision model 서버다. LLM 설정과 따로 저장하고,
 *   대화 모델이 아니라서 모델 목록에 나오지 않는다.
 * - 자격 증명은 메모리에만 둔다 (auth.json을 만들지 않는다).
 * - models.json을 읽지 않고, 네트워크로 모델 카탈로그를 받지 않는다.
 * - API 키는 config 값 확장(`!cmd`, `$VAR`)을 거치지 않도록 runtime key로 넣는다.
 */

/** `/v1/responses`의 reasoning.effort 값. pi thinking level과 이름이 같고 none만 off다. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const thinkingLevelOf = (effort: ReasoningEffort): string => (effort === "none" ? "off" : effort);

/** 세션의 thinking level을 지금 모델에 맞춘다. null(effort를 고른 적 없음)이거나 모델이 받지 않는 값이면 모델의 기본값이다. */
export function thinkingLevelIn(model: LlmModelConfig, level: string | null): string {
  if (!model.reasoning) return "off";
  return level !== null && model.efforts.map(thinkingLevelOf).includes(level) ? level : thinkingLevelOf(model.defaultEffort);
}

export const LlmModelConfig = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
    /** reasoning 모델이 받는 effort. 목록에 없는 effort를 요청하면 400 */
    efforts: z.array(z.enum(REASONING_EFFORTS)).default(["none", "minimal", "low", "medium", "high"]),
    /** 요청에 effort가 없을 때 쓰는 값 */
    defaultEffort: z.enum(REASONING_EFFORTS).default("high"),
    input: z.array(z.enum(["text", "image"])).default(["text"]),
  })
  .superRefine((m, ctx) => {
    if (m.reasoning && !m.efforts.includes(m.defaultEffort)) {
      ctx.addIssue({ code: "custom", path: ["defaultEffort"], message: "defaultEffort must be one of efforts" });
    }
  });
export type LlmModelConfig = z.infer<typeof LlmModelConfig>;

export const LlmServer = z.object({
  /** pi provider id, `/v1/models`의 owned_by */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "server id must be 1-32 lowercase letters, digits, _ or -"),
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
});
export type LlmServer = z.infer<typeof LlmServer>;

/** System One: mcp_search가 쓰는 decision model. `{baseUrl}/systemone`으로 묻는다 (vLLM이면 base URL은 `/v1`까지). */
export const SystemOneModel = z.object({
  baseUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  /** 빈 값 = 키가 없는 엔드포인트 */
  apiKey: z.string(),
  /** 요청마다 붙일 헤더 */
  headers: z.record(z.string(), z.string()).default({}),
  id: z.string().min(1),
});
export type SystemOneModel = z.infer<typeof SystemOneModel>;

export interface SystemOneRecord {
  model: SystemOneModel;
  updatedAt: string;
}

/** 클라이언트가 모델 id 대신 부를 수 있는 이름. 큰 모델부터. */
export const TIERS = ["eagle", "falcon", "swift"] as const;
export type Tier = (typeof TIERS)[number];

export const LlmSettings = z
  .object({
    servers: z.array(LlmServer).min(1),
    defaultModel: z.string().min(1),
    /** 티어 → 모델 id. 없는 티어는 쓰지 않는다. */
    tiers: z.partialRecord(z.enum(TIERS), z.string().min(1)).default({}),
  })
  .superRefine((s, ctx) => {
    const dup = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    const servers = dup(s.servers.map((x) => x.id));
    if (servers.length) ctx.addIssue({ code: "custom", path: ["servers"], message: `server ids must be unique: ${servers.join(", ")}` });
    const ids = s.servers.flatMap((x) => x.models.map((m) => m.id));
    const models = dup(ids);
    if (models.length) ctx.addIssue({ code: "custom", path: ["servers"], message: `model ids must be unique across servers: ${models.join(", ")}` });
    if (!ids.includes(s.defaultModel) && !Object.hasOwn(s.tiers, s.defaultModel)) {
      ctx.addIssue({ code: "custom", path: ["defaultModel"], message: "defaultModel must be one of models or set tiers" });
    }
    for (const [tier, model] of Object.entries(s.tiers)) {
      if (!ids.includes(model)) ctx.addIssue({ code: "custom", path: ["tiers", tier], message: `tier ${tier} must point to one of models` });
      if (ids.includes(tier)) ctx.addIssue({ code: "custom", path: ["tiers", tier], message: `a model is already named ${tier}` });
    }
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

export interface LlmSettingsRecord {
  settings: LlmSettings;
  updatedAt: string;
}

export type LlmModelEntry = LlmModelConfig & { server: string };

export interface GatewayModels {
  runtime: ModelRuntime;
  /** 티어면 가리키는 모델 */
  get(name: string): Model<Api> | undefined;
  /** 티어면 가리키는 모델의 설정 (id는 실제 모델 id) */
  config(name: string): LlmModelConfig | undefined;
  /** 클라이언트가 부를 수 있는 이름: 설정된 티어(가리키는 모델의 설정에 id만 티어 이름), 그다음 모든 서버의 모델 (서버 순서대로) */
  list(): LlmModelEntry[];
  /** 설정되지 않았으면 undefined */
  defaultModel(): string | undefined;
  /** 설정이 바뀔 때마다 1씩 오른다 */
  revision(): number;
  current(): LlmSettingsRecord | null;
  /** System One 설정. 없으면 null이고 mcp_search는 BM25로 찾는다. */
  systemOne(): SystemOneRecord | null;
  /** 등록한 뒤 저장한다 (null이면 지운다). 바로 적용된다. */
  setSystemOne(model: SystemOneModel | null): Promise<SystemOneRecord | null>;
  /** choose가 보낸 최근 요청 (최신부터). 메모리에만 있어 다시 시작하면 비워진다. */
  systemOneCalls(): readonly SystemOneCall[];
  /**
   * System One에 choice 질문 하나를 묻고 선택지별 확률을 돌려준다.
   * 설정되지 않았으면 undefined, 호출이 실패하면 던진다.
   */
  choose(question: ChoiceQuestion, signal?: AbortSignal): Promise<Record<string, number> | undefined>;
  /** 검증하고 provider를 다시 등록한 뒤 저장한다. 등록에 실패하면 이전 설정으로 되돌리고 던진다. */
  update(settings: LlmSettings): Promise<LlmSettingsRecord>;
}

const MIGRATIONS = [
  `CREATE TABLE llm_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     settings_json TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  // 서버 하나짜리 설정 → servers 목록. 서버 id는 이전 provider id다.
  `UPDATE llm_settings SET settings_json = json_object(
     'servers', json_array(json_set(json_remove(settings_json, '$.defaultModel'), '$.id', 'upstream')),
     'defaultModel', json_extract(settings_json, '$.defaultModel'))`,
  // 관리 화면은 행위자를 보내지 않아 늘 "admin"이었다.
  `ALTER TABLE llm_settings DROP COLUMN updated_by`,
  `CREATE TABLE systemone_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     settings_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // LLM 설정 안에 있던 검색 모델을 옮긴다.
  `INSERT INTO systemone_settings (id, settings_json, updated_at)
     SELECT 1, json_extract(settings_json, '$.searchModel'), updated_at FROM llm_settings
     WHERE json_extract(settings_json, '$.searchModel') IS NOT NULL`,
  `UPDATE llm_settings SET settings_json = json_remove(settings_json, '$.searchModel')`,
];

const createRuntime = () =>
  ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

async function register(runtime: ModelRuntime, s: LlmServer): Promise<void> {
  const compat = s.api === "openai-completions" ? { ...DEFAULT_OPENAI_COMPAT, ...s.compat } : { ...s.compat };
  runtime.unregisterProvider(s.id);
  runtime.registerProvider(s.id, {
    name: s.id,
    baseUrl: s.baseUrl,
    api: s.api,
    ...(Object.keys(s.headers).length > 0 ? { headers: s.headers } : {}),
    models: s.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: s.api,
      reasoning: m.reasoning,
      // pi는 xhigh·max를 map에 있을 때만 지원한다고 본다. 고른 값 그대로 보낸다.
      ...(m.reasoning ? { thinkingLevelMap: Object.fromEntries(m.efforts.filter((e) => e === "xhigh" || e === "max").map((e) => [e, e])) } : {}),
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      ...(Object.keys(compat).length > 0 ? { compat: compat as never } : {}),
    })),
  });
  // 키가 없는 엔드포인트에도 pi는 키 값을 요구한다
  await runtime.setRuntimeApiKey(s.id, s.apiKey || "not-needed");
  for (const m of s.models) {
    if (!runtime.getModel(s.id, m.id)) throw new Error(`model ${m.id} could not be registered with pi`);
  }
}

/** System One의 pi provider id. 서버 id에는 `.`을 쓸 수 없어 겹치지 않는다. */
const SYSTEMONE_PROVIDER = "system.one";
/** pi가 classifier 모델에 요구하는 값. 요청을 막는 데 쓰이지 않고, 넘치면 서버가 오류를 돌려준다. */
const SYSTEMONE_CONTEXT_WINDOW = 131_072;
/** 넘으면 그 검색은 BM25로 찾는다. */
const SYSTEMONE_TIMEOUT_MS = 10_000;
/** 관리 화면에 보여 주려고 메모리에 두는 최근 요청 수. 요청 하나에 모든 도구 설명이 들어가 DB에는 남기지 않는다. */
const SYSTEMONE_RECENT_CALLS = 20;

/** next를 등록한다 (null이면 내리기만 한다) */
async function applySystemOne(runtime: ModelRuntime, next: SystemOneModel | null): Promise<void> {
  runtime.unregisterProvider(SYSTEMONE_PROVIDER);
  await runtime.removeRuntimeApiKey(SYSTEMONE_PROVIDER);
  if (!next) return;
  runtime.registerProvider(SYSTEMONE_PROVIDER, {
    name: SYSTEMONE_PROVIDER,
    baseUrl: next.baseUrl,
    ...(Object.keys(next.headers).length > 0 ? { headers: next.headers } : {}),
    classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
    models: [
      {
        type: "classifier",
        id: next.id,
        name: next.id,
        api: "typesafe-system-one",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: SYSTEMONE_CONTEXT_WINDOW,
      },
    ],
  });
  await runtime.setRuntimeApiKey(SYSTEMONE_PROVIDER, next.apiKey || "not-needed");
  if (!runtime.getModelOfType("classifier", SYSTEMONE_PROVIDER, next.id)) throw new Error(`model ${next.id} could not be registered with pi`);
}

/** System One 요청 하나의 기록 (관리 화면의 테스트 결과와 최근 요청) */
export interface SystemOneCall {
  at: string;
  durationMs: number;
  /** `/systemone`으로 보낸 요청 본문 (보내기 전에 실패했으면 없다) */
  request?: unknown;
  /** 받은 답: 고른 선택지, 선택지별 확률, confidence. 실패했으면 없다. */
  answer?: ClassifierChoiceAnswer;
  /** 실패한 이유 */
  error?: string;
}

/** 등록된 System One 모델에 choice 질문 하나를 묻는다. 던지지 않고 실패도 기록으로 돌려준다. */
async function call(runtime: ModelRuntime, id: string, question: ChoiceQuestion, signal?: AbortSignal): Promise<SystemOneCall> {
  const started = Date.now();
  const record: SystemOneCall = { at: new Date(started).toISOString(), durationMs: 0 };
  try {
    const model = runtime.getModelOfType("classifier", SYSTEMONE_PROVIDER, id);
    if (!model) throw new Error(`model ${id} is not registered`);
    const result = await runtime.classify(
      model,
      { state: question.state, questions: { choice: { type: "choice", instructions: question.instructions, criteria: question.criteria } } },
      {
        signal,
        timeoutMs: SYSTEMONE_TIMEOUT_MS,
        // 실패하면 mcp_search가 BM25로 찾으므로 다시 시도하지 않는다
        maxRetries: 0,
        onPayload: (payload) => {
          record.request = payload;
          return undefined;
        },
      },
    );
    const answer = result.answers.choice;
    if (result.stopReason !== "stop" || answer?.type !== "choice") throw new Error(result.errorMessage ?? "System One returned no answer");
    record.answer = answer;
  } catch (err) {
    record.error = describe(err);
  }
  record.durationMs = Date.now() - started;
  return record;
}

/** previous에서 next로 provider를 바꾼다 (없어진 서버는 내린다) */
async function apply(runtime: ModelRuntime, next: LlmSettings | null, previous: LlmSettings | null): Promise<void> {
  for (const s of previous?.servers ?? []) {
    if (next?.servers.some((n) => n.id === s.id)) continue;
    runtime.unregisterProvider(s.id);
    await runtime.removeRuntimeApiKey(s.id);
  }
  for (const s of next?.servers ?? []) await register(runtime, s);
}

export async function createModelRuntime(db: Db): Promise<GatewayModels> {
  // pi는 PI_OFFLINE이 있으면 모델 카탈로그·도구 다운로드 등 네트워크 접근을 하지 않는다.
  process.env.PI_OFFLINE ??= "1";
  migrate(db, "llm", MIGRATIONS);
  const runtime = await createRuntime();

  const row = db.prepare("SELECT settings_json, updated_at FROM llm_settings WHERE id = 1").get() as
    | { settings_json: string; updated_at: string }
    | undefined;
  let current: LlmSettingsRecord | null = row
    ? { settings: LlmSettings.parse(JSON.parse(row.settings_json)), updatedAt: row.updated_at }
    : null;
  if (current) await apply(runtime, current.settings, null);
  let revision = 0;

  const systemOneRow = db.prepare("SELECT settings_json, updated_at FROM systemone_settings WHERE id = 1").get() as
    | { settings_json: string; updated_at: string }
    | undefined;
  let systemOne: SystemOneRecord | null = systemOneRow
    ? { model: SystemOneModel.parse(JSON.parse(systemOneRow.settings_json)), updatedAt: systemOneRow.updated_at }
    : null;
  if (systemOne) await applySystemOne(runtime, systemOne.model);
  const systemOneCalls: SystemOneCall[] = [];

  const save = db.prepare(
    `INSERT INTO llm_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  );
  const modelId = (name: string) => current?.settings.tiers[name as Tier] ?? name;
  const serverOf = (id: string) => current?.settings.servers.find((s) => s.models.some((m) => m.id === id));
  const entries = (): LlmModelEntry[] => current?.settings.servers.flatMap((s) => s.models.map((m) => ({ ...m, server: s.id }))) ?? [];

  return {
    runtime,
    get: (name) => {
      const id = modelId(name);
      const server = serverOf(id);
      return server ? runtime.getModel(server.id, id) : undefined;
    },
    config: (name) => {
      const id = modelId(name);
      return serverOf(id)?.models.find((m) => m.id === id);
    },
    list: () => {
      const models = entries();
      const tiers = TIERS.flatMap((tier) => {
        const target = models.find((m) => m.id === current?.settings.tiers[tier]);
        if (!target) return [];
        const { name: _, ...rest } = target;
        return [{ ...rest, id: tier }];
      });
      return [...tiers, ...models];
    },
    defaultModel: () => current?.settings.defaultModel,
    revision: () => revision,
    current: () => current,
    systemOne: () => systemOne,
    async setSystemOne(input) {
      const model = input && SystemOneModel.parse(input);
      try {
        await applySystemOne(runtime, model);
      } catch (err) {
        await applySystemOne(runtime, systemOne?.model ?? null);
        throw err;
      }
      const updatedAt = new Date().toISOString();
      if (model) {
        db.prepare(
          `INSERT INTO systemone_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
        ).run(JSON.stringify(model), updatedAt);
      } else {
        db.prepare("DELETE FROM systemone_settings WHERE id = 1").run();
      }
      systemOne = model && { model, updatedAt };
      return systemOne;
    },
    systemOneCalls: () => systemOneCalls,
    async choose(question, signal) {
      if (!systemOne) return undefined;
      const record = await call(runtime, systemOne.model.id, question, signal);
      systemOneCalls.unshift(record);
      systemOneCalls.length = Math.min(systemOneCalls.length, SYSTEMONE_RECENT_CALLS);
      if (!record.answer) throw new Error(record.error);
      return record.answer.probabilities;
    },
    async update(input) {
      const settings = LlmSettings.parse(input);
      const previous = current?.settings ?? null;
      try {
        await apply(runtime, settings, previous);
      } catch (err) {
        await apply(runtime, previous, settings);
        throw err;
      }
      const next = { settings, updatedAt: new Date().toISOString() };
      save.run(JSON.stringify(settings), next.updatedAt);
      current = next;
      revision++;
      return next;
    },
  };
}

// ── 관리 화면의 연결 확인 ─────────────────────────────────────────────

export interface LlmProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 서버가 알려 준 모델. contextWindow는 서버가 줄 때만 (vLLM의 max_model_len) */
  models?: { id: string; name?: string; contextWindow?: number }[];
}

export interface LlmTestResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 답의 앞부분 */
  text?: string;
  /** 답 전에 생각(reasoning)을 했는지 */
  thinking?: boolean;
  stopReason?: string;
  usage?: { input: number; output: number };
}

function describe(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timed out";
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause ? `${err.message} (${cause})` : err.message;
}

const positiveInt = (...values: unknown[]) => values.find((v): v is number => Number.isInteger(v) && (v as number) > 0);

/** 서버의 모델 목록을 받는다 (연결·인증 확인 겸). openai는 `{baseUrl}/models`, anthropic은 `{baseUrl}/v1/models`. */
export async function probeLlmServer(
  server: Pick<LlmServer, "api" | "baseUrl" | "apiKey" | "headers">,
  timeoutMs = 10_000,
): Promise<LlmProbeResult> {
  const started = Date.now();
  const anthropic = server.api === "anthropic-messages";
  const headers: Record<string, string> = { ...server.headers, accept: "application/json" };
  // 키는 pi가 실제 요청에 넣는 방식대로 보낸다
  if (anthropic) headers["anthropic-version"] = "2023-06-01";
  if (server.apiKey) headers[anthropic ? "x-api-key" : "authorization"] = anthropic ? server.apiKey : `Bearer ${server.apiKey}`;
  try {
    const res = await fetch(`${server.baseUrl}${anthropic ? "/v1/models?limit=1000" : "/models"}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) return { ok: false, durationMs: Date.now() - started, error: `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 300)}` : ""}` };
    let data: unknown;
    try {
      data = (JSON.parse(text) as { data?: unknown }).data;
    } catch {
      return { ok: false, durationMs: Date.now() - started, error: "the response is not JSON (check the base URL)" };
    }
    if (!Array.isArray(data)) return { ok: false, durationMs: Date.now() - started, error: "the response has no data list (check the base URL)" };
    const models = data
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string")
      .map((m) => {
        const contextWindow = positiveInt(m.max_model_len, m.context_length, m.context_window);
        return {
          id: m.id as string,
          ...(typeof m.display_name === "string" ? { name: m.display_name } : {}),
          ...(contextWindow ? { contextWindow } : {}),
        };
      });
    return { ok: true, durationMs: Date.now() - started, models };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - started, error: describe(err) };
  }
}

/**
 * 모델에 짧은 요청을 보낸다. 세션과 같은 pi 경로(compat·헤더 포함)를 쓰되,
 * 저장하기 전 설정도 시험할 수 있도록 따로 만든 runtime에 등록한다.
 */
export async function testLlmModel(server: LlmServer, modelId: string, timeoutMs = 60_000): Promise<LlmTestResult> {
  const started = Date.now();
  const config = server.models.find((m) => m.id === modelId);
  if (!config) return { ok: false, durationMs: 0, error: `model ${modelId} is not on server ${server.id}` };
  try {
    const runtime = await createRuntime();
    await register(runtime, { ...server, models: [config] });
    const reply = await runtime.completeSimple(
      runtime.getModel(server.id, modelId)!,
      { messages: [{ role: "user", content: "Reply with one word: OK", timestamp: Date.now() }] },
      // reasoning 모델은 생각할 몫을 더 준다
      { maxTokens: Math.min(config.maxTokens, config.reasoning ? 512 : 32), signal: AbortSignal.timeout(timeoutMs) },
    );
    const durationMs = Date.now() - started;
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return { ok: false, durationMs, error: reply.errorMessage ?? reply.stopReason };
    }
    const text = reply.content
      .flatMap((c) => (c.type === "text" ? [c.text] : []))
      .join("")
      .trim();
    return {
      ok: true,
      durationMs,
      text: text.slice(0, 200),
      thinking: reply.content.some((c) => c.type === "thinking"),
      stopReason: reply.stopReason,
      usage: { input: reply.usage.input, output: reply.usage.output },
    };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - started, error: describe(err) };
  }
}

/** System One 서버에 짧은 choice 질문을 보낸다. 세션과 같은 pi 경로를 쓰되, 저장하기 전 설정도 시험할 수 있도록 따로 만든 runtime에 등록한다. */
export async function testSystemOne(model: SystemOneModel): Promise<SystemOneCall> {
  const started = Date.now();
  let runtime: ModelRuntime;
  try {
    runtime = await createRuntime();
    await applySystemOne(runtime, model);
  } catch (err) {
    return { at: new Date(started).toISOString(), durationMs: Date.now() - started, error: describe(err) };
  }
  return call(runtime, model.id, {
    state: { message: "The deploy finished without errors." },
    instructions: "Is `message` good news or bad news?",
    criteria: { good: "Good news", bad: "Bad news" },
  });
}
