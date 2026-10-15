import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { PromptRenderInput } from "../contracts.js";

/** 프롬프트 템플릿 변수. 이 밖의 `{{…}}`는 그대로 둔다. */
export const PROMPT_VARIABLES = ["USER", "DATE", "DATETIME", "WORKSPACE", "WORKSPACE_PERSISTENCE", "MODEL", "LANGUAGE"] as const;

/** 로그인 사용자의 workspace는 남고, 익명 세션의 workspace는 세션이 끝나면 지워진다. */
export const WORKSPACE_PERSISTENCE = {
  user: "kept between conversations with this user",
  anonymous: "temporary and are deleted when this conversation ends",
} as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];
export type PromptVars = Record<PromptVariable, string>;

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const KNOWN = new Set<string>(PROMPT_VARIABLES);

function datePart(now: Date, timeZone: string): string {
  // en-CA는 YYYY-MM-DD 형식을 준다.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function timePart(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

export function buildPromptVars(input: PromptRenderInput, language: string, timeZone?: string): PromptVars {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const date = datePart(input.now, tz);
  return {
    USER: input.user ?? "anonymous",
    DATE: date,
    DATETIME: `${date} ${timePart(input.now, tz)} (${tz})`,
    WORKSPACE: SANDBOX_WORKSPACE,
    WORKSPACE_PERSISTENCE: input.user ? WORKSPACE_PERSISTENCE.user : WORKSPACE_PERSISTENCE.anonymous,
    MODEL: input.model,
    LANGUAGE: language,
  };
}

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(TOKEN, (whole, name: string) => (KNOWN.has(name) ? vars[name as PromptVariable] : whole));
}

/** 템플릿 안의 변수 사용 현황 (미리보기·편집 화면용) */
export function analyzePrompt(template: string): { used: PromptVariable[]; unknown: string[] } {
  const used = new Set<PromptVariable>();
  const unknown = new Set<string>();
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1] ?? "";
    if (KNOWN.has(name)) used.add(name as PromptVariable);
    else unknown.add(match[0]);
  }
  return { used: PROMPT_VARIABLES.filter((v) => used.has(v)), unknown: [...unknown] };
}
