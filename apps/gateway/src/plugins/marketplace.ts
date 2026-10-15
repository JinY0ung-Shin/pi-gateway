import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { badRequest } from "../admin/errors.js";
import { isObject, type JsonObject, parseJsonLenient, safeName, str } from "./manifest.js";
import { isInside, readContainedFile } from "./safe-copy.js";

/** 설치에 쓸 수 있는 source. npm·archive·command는 v1에서 지원하지 않는다. */
export type PluginSource =
  | { type: "relative"; path: string }
  | { type: "github"; repo: string; ref?: string; sha?: string }
  | { type: "url"; url: string; ref?: string; sha?: string }
  | { type: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
  | { type: "unsupported"; kind: string };

export interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  tags: string[];
  source: PluginSource;
  /** 기본값 true */
  strict: boolean;
  raw: JsonObject;
}

export interface MarketplaceManifest {
  name: string;
  description?: string;
  owner?: string;
  pluginRoot?: string;
  plugins: MarketplaceEntry[];
  /** 읽지 못한 항목 */
  invalid: { index: number; reason: string }[];
}

export async function readMarketplaceManifest(root: string): Promise<MarketplaceManifest> {
  const path = ".claude-plugin/marketplace.json";
  const text = await readContainedFile(root, path, { optional: true });
  if (text === undefined) throw badRequest(`the repository has no ${path}`);
  return parseMarketplaceManifest(parseJsonLenient(text, path));
}

export function parseMarketplaceManifest(json: unknown): MarketplaceManifest {
  if (!isObject(json)) throw badRequest("marketplace.json must be a JSON object");
  const name = safeName(json.name, "marketplace name");
  const metadata = isObject(json.metadata) ? json.metadata : {};
  const owner = isObject(json.owner) ? str(json.owner, "name") : undefined;
  const pluginRoot = str(metadata, "pluginRoot");
  if (!Array.isArray(json.plugins)) throw badRequest("marketplace.json must have a plugins array");
  const plugins: MarketplaceEntry[] = [];
  const invalid: MarketplaceManifest["invalid"] = [];
  json.plugins.forEach((raw, index) => {
    try {
      plugins.push(parseEntry(raw));
    } catch (error) {
      invalid.push({ index, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  const description = str(json, "description") ?? str(metadata, "description");
  return {
    name,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    ...(pluginRoot ? { pluginRoot } : {}),
    plugins,
    invalid,
  };
}

function parseEntry(raw: unknown): MarketplaceEntry {
  if (!isObject(raw)) throw new Error("plugin entry must be an object");
  const name = safeName(raw.name, "plugin name");
  const description = str(raw, "description");
  const version = str(raw, "version");
  const category = str(raw, "category");
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    name,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(category ? { category } : {}),
    tags,
    source: parseSource(raw.source),
    strict: raw.strict !== false,
    raw,
  };
}

export function parseSource(value: unknown): PluginSource {
  if (typeof value === "string") return { type: "relative", path: value };
  if (!isObject(value)) throw new Error("plugin source must be a path string or an object");
  const kind = str(value, "source");
  const ref = str(value, "ref");
  const sha = str(value, "sha");
  const pins = { ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
  switch (kind) {
    case "github": {
      const repo = str(value, "repo");
      if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("github source needs repo in owner/repo form");
      return { type: "github", repo, ...pins };
    }
    case "url": {
      const url = str(value, "url");
      if (!url) throw new Error("url source needs url");
      return { type: "url", url, ...pins };
    }
    case "git-subdir": {
      const url = str(value, "url");
      const path = str(value, "path");
      if (!url || !path) throw new Error("git-subdir source needs url and path");
      return { type: "git-subdir", url, path, ...pins };
    }
    default:
      return { type: "unsupported", kind: kind ?? "unknown" };
  }
}

export function describeSource(source: PluginSource): string {
  switch (source.type) {
    case "relative":
      return source.path;
    case "github":
      return `github:${source.repo}${source.ref ? `#${source.ref}` : ""}`;
    case "url":
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
    case "git-subdir":
      return `${source.url}//${source.path}${source.ref ? `#${source.ref}` : ""}`;
    case "unsupported":
      return `${source.kind} (지원 안 함)`;
  }
}

/** 상대 경로가 root를 벗어나지 않는지 확인하고 절대 경로로 바꾼다. */
export async function resolveInside(root: string, relPath: string, what: string): Promise<string> {
  if (relPath.includes("\\") || relPath.split("/").includes("..") || relPath.startsWith("/")) {
    throw badRequest(`${what} '${relPath}' must be a relative path inside the repository`);
  }
  const rootReal = await realpath(root);
  let resolved: string;
  try {
    resolved = await realpath(join(rootReal, relPath));
  } catch {
    throw badRequest(`${what} '${relPath}' does not exist`);
  }
  if (!isInside(rootReal, resolved)) throw badRequest(`${what} '${relPath}' points outside the repository`);
  return resolved;
}

/** 상대 경로 source를 marketplace 저장소 안의 디렉토리로 바꾼다 (`.`, `./x`, pluginRoot 아래 bare name). */
export async function resolveRelativeSource(marketplaceRoot: string, source: string, pluginRoot?: string): Promise<string> {
  if (source === ".") return realpath(marketplaceRoot);
  if (source.startsWith("./")) return resolveInside(marketplaceRoot, source.slice(2), "plugin source");
  if (pluginRoot && /^[A-Za-z0-9._-]+$/.test(source)) {
    const base = pluginRoot.startsWith("./") ? pluginRoot.slice(2) : pluginRoot;
    return resolveInside(marketplaceRoot, `${base.replace(/\/+$/, "")}/${source}`, "plugin source");
  }
  throw badRequest(`relative plugin source '${source}' must start with ./`);
}
