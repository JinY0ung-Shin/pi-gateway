import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import type { PromptRenderInput } from "../contracts.js";

/** 프롬프트 템플릿 변수. 이 밖의 `{{…}}`는 그대로 둔다. */
export const PROMPT_VARIABLES = ["USER", "DATE", "DATETIME", "WORKSPACE", "MODEL", "LANGUAGE"] as const;

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

export function buildPromptVars(input: PromptRenderInput, language: string): PromptVars {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const date = datePart(input.now, tz);
  return {
    USER: input.user,
    DATE: date,
    DATETIME: `${date} ${timePart(input.now, tz)} (${tz})`,
    WORKSPACE: SANDBOX_WORKSPACE,
    MODEL: input.model,
    LANGUAGE: language,
  };
}

export function renderPrompt(template: string, vars: PromptVars): string {
  return template.replace(TOKEN, (whole, name: string) => (KNOWN.has(name) ? vars[name as PromptVariable] : whole));
}

/** 템플릿 안의 모르는 변수 (편집 화면 미리보기용) */
export function unknownVariables(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(TOKEN)) if (!KNOWN.has(match[1] ?? "")) unknown.add(match[0]);
  return [...unknown];
}
