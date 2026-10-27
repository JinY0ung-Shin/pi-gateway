import { badRequest } from "../admin/errors.js";
import { readContainedFile } from "./safe-copy.js";

export type JsonObject = Record<string, unknown>;

/**
 * BOM을 허용하는 JSON 파서.
 * 파서 오류 메시지에는 입력 일부가 들어가므로 쓰지 않고, 파일의 상대 경로만 알려준다.
 */
export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw badRequest(`${what} is not valid JSON`);
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 문자열 하나 또는 문자열 배열을 배열로 */
export function pathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** `.claude-plugin/plugin.json`. 없으면 undefined. 링크이거나 plugin 밖을 가리키면 거절한다. */
export async function readPluginManifest(pluginDir: string): Promise<JsonObject | undefined> {
  const path = ".claude-plugin/plugin.json";
  const text = await readContainedFile(pluginDir, path, { optional: true });
  if (text === undefined) return undefined;
  const parsed = parseJson(text, path);
  if (!isObject(parsed)) throw badRequest(`${path} must be a JSON object`);
  return parsed;
}

/** marketplace 이름·plugin 이름 (디렉토리 이름으로도 쓴다) */
export const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeName(value: unknown, what: string): string {
  if (typeof value !== "string" || !COMPONENT_NAME.test(value) || value === "." || value === "..") {
    throw badRequest(`${what} must match ${COMPONENT_NAME.source}`);
  }
  return value;
}

/** 설치 디렉토리 이름으로 쓸 수 있게 버전 문자열을 정리한다. */
export function safeVersion(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 64);
  if (!cleaned || cleaned === "." || cleaned === "..") return "unknown";
  // "current"는 설치본의 고정 경로(현재 버전을 가리키는 링크) 이름이고, 점으로 시작하는 이름은 작업용이다.
  if (cleaned === "current" || cleaned.startsWith(".")) return `v${cleaned}`;
  return cleaned;
}
