import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { type Db, migrate } from "../db.js";

/**
 * 모든 세션이 공유하는 ModelRuntime과 LLM 연결 설정.
 * - 설정은 관리 화면에서 바꾸고 gateway DB에 저장한다. 바꾸면 바로 provider를 다시 등록한다.
 *   메모리의 세션은 다음 턴에 새 설정으로 다시 연다 (revision이 바뀌었는지 SessionHub가 본다).
 * - LLM 서버마다 pi provider 하나로 등록한다 (provider id = 서버 id). 모델 id는 서버 전체에서 겹치지 않는다.
 * - 자격 증명은 메모리에만 둔다 (auth.json을 만들지 않는다).
 * - models.json을 읽지 않고, 네트워크로 모델 카탈로그를 받지 않는다.
 * - API 키는 config 값 확장(`!cmd`, `$VAR`)을 거치지 않도록 runtime key로 넣는다.
 */

/** `/v1/responses`의 reasoning.effort 값. pi thinking level과 이름이 같고 none만 off다. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const thinkingLevelOf = (effort: ReasoningEffort): string => (effort === "none" ? "off" : effort);

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

export const LlmSettings = z
  .object({
    servers: z.array(LlmServer).min(1),
    defaultModel: z.string().min(1),
  })
  .superRefine((s, ctx) => {
    const dup = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    const servers = dup(s.servers.map((x) => x.id));
    if (servers.length) ctx.addIssue({ code: "custom", path: ["servers"], message: `server ids must be unique: ${servers.join(", ")}` });
    const ids = s.servers.flatMap((x) => x.models.map((m) => m.id));
    const models = dup(ids);
    if (models.length) ctx.addIssue({ code: "custom", path: ["servers"], message: `model ids must be unique across servers: ${models.join(", ")}` });
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

export interface LlmSettingsRecord {
  settings: LlmSettings;
  updatedAt: string;
}

export type LlmModelEntry = LlmModelConfig & { server: string };

export interface GatewayModels {
  runtime: ModelRuntime;
  get(id: string): Model<Api> | undefined;
  config(id: string): LlmModelConfig | undefined;
  /** 모든 서버의 모델 (서버 순서대로) */
  list(): LlmModelEntry[];
  /** 설정되지 않았으면 undefined */
  defaultModel(): string | undefined;
  /** 설정이 바뀔 때마다 1씩 오른다 */
  revision(): number;
  current(): LlmSettingsRecord | null;
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

  const save = db.prepare(
    `INSERT INTO llm_settings (id, settings_json, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
  );
  const serverOf = (id: string) => current?.settings.servers.find((s) => s.models.some((m) => m.id === id));

  return {
    runtime,
    get: (id) => {
      const server = serverOf(id);
      return server ? runtime.getModel(server.id, id) : undefined;
    },
    config: (id) => serverOf(id)?.models.find((m) => m.id === id),
    list: () => current?.settings.servers.flatMap((s) => s.models.map((m) => ({ ...m, server: s.id }))) ?? [],
    defaultModel: () => current?.settings.defaultModel,
    revision: () => revision,
    current: () => current,
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
