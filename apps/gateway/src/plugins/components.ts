import { existsSync } from "node:fs";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { PlatformError } from "../admin/errors.js";
import { argumentNamesFrom, convertCommandBody } from "./commands.js";
import { firstLine, frontmatterFlag, frontmatterString, parseMarkdownFrontmatter } from "./frontmatter.js";
import { isObject, type JsonObject, parseJson, pathList } from "./manifest.js";
import { mcpServerMap } from "./mcp-mapping.js";
import { isInside, readContainedFile } from "./safe-copy.js";

/** SKILL.md·command 파일 하나의 최대 크기 */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

export interface SkillRecord {
  name: string;
  description: string;
  /** 설치 후 경로 */
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface CommandRecord {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  filePath: string;
  notes: string[];
}

export interface AgentRecord {
  name: string;
  description: string;
  /** frontmatter `tools` (Claude Code 도구 이름). 없으면 전부 */
  tools?: string[];
  /** 본문 (plugin 변수 치환 후) */
  prompt: string;
  filePath: string;
  notes: string[];
}

export type UnsupportedKind =
  | "hooks"
  | "lsp"
  | "output-styles"
  | "workflows"
  | "monitors"
  | "themes"
  | "bin"
  | "user-config"
  | "channels"
  | "settings"
  | "dependencies"
  | "npm-dependencies"
  | "mcp-bundle";

export interface UnsupportedComponent {
  kind: UnsupportedKind;
  detail: string;
}

export interface DiscoveredComponents {
  skills: SkillRecord[];
  commands: CommandRecord[];
  agents: AgentRecord[];
  /** 서버 이름 → Claude 형식 설정 (변환 전) */
  mcpServers: Record<string, unknown>;
  unsupported: UnsupportedComponent[];
  warnings: string[];
  /** 설치 후 치환할 텍스트 파일 (staging 기준 경로) */
  textFiles: { path: string; skillDir?: string }[];
}

export interface DiscoverInput {
  stagingDir: string;
  finalDir: string;
  pluginName: string;
  /** plugin.json (없으면 marketplace 항목) */
  manifest: JsonObject;
  dataDir: string;
}

const MAX_SKILL_DESCRIPTION = 1024;

const rel = (p: string) => p.replace(/^\.\/?/, "");

export async function discoverComponents(input: DiscoverInput): Promise<DiscoveredComponents> {
  const out: DiscoveredComponents = { skills: [], commands: [], agents: [], mcpServers: {}, unsupported: [], warnings: [], textFiles: [] };
  const { manifest } = input;
  const toFinal = (stagingPath: string) => join(input.finalDir, relative(input.stagingDir, stagingPath));
  const inside = (p: string) => isInside(input.stagingDir, p);
  const relOf = (p: string) => relative(input.stagingDir, p);
  /** SKILL.md·command 같은 내용 파일: 링크이거나 밖을 가리키면 경고만 남기고 건너뛴다. */
  const readContent = async (p: string): Promise<string | undefined> => {
    try {
      return await readContainedFile(input.stagingDir, relOf(p), { maxBytes: MAX_CONTENT_BYTES });
    } catch (error) {
      if (error instanceof PlatformError) {
        out.warnings.push(`${error.message}; skipped`);
        return undefined;
      }
      throw error;
    }
  };
  /** .mcp.json 같은 manifest: 링크이거나 밖을 가리키면 설치를 거절한다 (readContainedFile이 던진다). */
  const readManifest = (p: string, optional = false) => readContainedFile(input.stagingDir, relOf(p), { optional });

  // ── skills ──
  const skillDirs = new Set<string>();
  for (const root of ["skills", ...pathList(manifest.skills)]) {
    const dir = join(input.stagingDir, rel(root));
    if (!inside(dir) || !(await isDir(dir))) {
      if (root !== "skills") out.warnings.push(`skills path '${root}' not found`);
      continue;
    }
    if (existsSync(join(dir, "SKILL.md"))) skillDirs.add(dir);
    else for (const child of await subdirs(dir)) if (existsSync(join(child, "SKILL.md"))) skillDirs.add(child);
  }
  if (existsSync(join(input.stagingDir, "SKILL.md"))) skillDirs.add(input.stagingDir);
  const seenSkills = new Set<string>();
  for (const dir of [...skillDirs].sort()) {
    const file = join(dir, "SKILL.md");
    const text = await readContent(file);
    if (text === undefined) continue;
    const parsed = parseMarkdownFrontmatter(text);
    const localName = frontmatterString(parsed.frontmatter, "name") ?? (dir === input.stagingDir ? input.pluginName : basename(dir));
    const name = `${input.pluginName}:${localName}`;
    if (seenSkills.has(name)) {
      out.warnings.push(`duplicate skill name '${name}' skipped`);
      continue;
    }
    seenSkills.add(name);
    let description = frontmatterString(parsed.frontmatter, "description") ?? firstLine(parsed.body);
    const when = frontmatterString(parsed.frontmatter, "when_to_use");
    if (when) description = `${description} ${when}`.trim();
    if (!description) out.warnings.push(`skill '${name}' has no description`);
    if (parsed.lenient) out.warnings.push(`skill '${name}' frontmatter is not strict YAML; read leniently`);
    out.skills.push({
      name,
      description: (description || localName).replace(/\s+/g, " ").slice(0, MAX_SKILL_DESCRIPTION),
      filePath: toFinal(file),
      baseDir: toFinal(dir),
      disableModelInvocation: frontmatterFlag(parsed.frontmatter, "disable-model-invocation"),
    });
    for (const md of await markdownFiles(dir)) out.textFiles.push({ path: md, skillDir: dir });
  }

  // ── commands ──
  const seenCommands = new Set<string>();
  const addCommand = (record: CommandRecord) => {
    if (seenCommands.has(record.name)) return;
    seenCommands.add(record.name);
    out.commands.push(record);
  };
  for (const path of pathList(manifest.commands ?? "./commands")) {
    const target = join(input.stagingDir, rel(path));
    if (!inside(target)) continue;
    if (await isDir(target)) {
      for (const file of await markdownFiles(target)) {
        const local = relative(target, file).replace(/\.md$/i, "").split(/[\\/]/).join(":");
        const text = await readContent(file);
        if (text === undefined) continue;
        addCommand(commandRecord(`${input.pluginName}:${local}`, text, toFinal(file)));
        out.textFiles.push({ path: file });
      }
    } else if (existsSync(target) && target.toLowerCase().endsWith(".md")) {
      const text = await readContent(target);
      if (text !== undefined) {
        addCommand(commandRecord(`${input.pluginName}:${basename(target).replace(/\.md$/i, "")}`, text, toFinal(target)));
        out.textFiles.push({ path: target });
      }
    } else if (path !== "./commands") {
      out.warnings.push(`commands path '${path}' not found`);
    }
  }

  // ── MCP ──
  const mcpText = await readManifest(join(input.stagingDir, ".mcp.json"), true);
  if (mcpText !== undefined) Object.assign(out.mcpServers, mcpServerMap(parseJson(mcpText, ".mcp.json")));
  const mcpSpecs = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers === undefined ? [] : [manifest.mcpServers];
  for (const spec of mcpSpecs) {
    if (typeof spec === "string") {
      if (/\.(mcpb|dxt)$/i.test(spec) || /^https?:/i.test(spec)) {
        out.unsupported.push({ kind: "mcp-bundle", detail: `MCP bundle '${spec}'` });
        continue;
      }
      const file = join(input.stagingDir, rel(spec));
      if (!inside(file) || !existsSync(file)) {
        out.warnings.push(`mcpServers file '${spec}' not found`);
        continue;
      }
      const text = (await readManifest(file))!;
      Object.assign(out.mcpServers, mcpServerMap(parseJson(text, relOf(file))));
    } else if (isObject(spec)) {
      Object.assign(out.mcpServers, mcpServerMap(spec));
    }
  }

  // ── agents ──
  const seenAgents = new Set<string>();
  for (const root of ["agents", ...pathList(manifest.agents)]) {
    const target = join(input.stagingDir, rel(root));
    if (!inside(target)) continue;
    const files = (await isDir(target)) ? await markdownFiles(target) : existsSync(target) && target.toLowerCase().endsWith(".md") ? [target] : [];
    if (files.length === 0 && root !== "agents") out.warnings.push(`agents path '${root}' not found`);
    for (const file of files) {
      const text = await readContent(file);
      if (text === undefined) continue;
      const parsed = parseMarkdownFrontmatter(text);
      const name = `${input.pluginName}:${frontmatterString(parsed.frontmatter, "name") ?? basename(file).replace(/\.md$/i, "")}`;
      if (seenAgents.has(name)) continue;
      seenAgents.add(name);
      const description = frontmatterString(parsed.frontmatter, "description") ?? firstLine(parsed.body);
      const tools = toolList(parsed.frontmatter.tools);
      out.agents.push({
        name,
        description: (description || name).replace(/\s+/g, " ").slice(0, MAX_SKILL_DESCRIPTION),
        ...(tools ? { tools } : {}),
        prompt: substitutePluginVars(parsed.body.trim(), input.finalDir, input.dataDir),
        filePath: toFinal(file),
        notes: Object.keys(parsed.frontmatter)
          .filter((key) => !AGENT_KEYS.has(key))
          .map((key) => `${key} 설정은 무시됩니다`),
      });
    }
  }

  // ── 지원하지 않는 구성요소 ──
  const note = (kind: UnsupportedKind, detail: string) => out.unsupported.push({ kind, detail });
  if (existsSync(join(input.stagingDir, "hooks", "hooks.json")) || manifest.hooks !== undefined) note("hooks", "hooks (도구 호출 전후 명령 실행)");
  if (existsSync(join(input.stagingDir, ".lsp.json")) || manifest.lspServers !== undefined) note("lsp", "LSP 서버");
  if ((await isDir(join(input.stagingDir, "output-styles"))) || manifest.outputStyles !== undefined) note("output-styles", "output styles");
  if ((await isDir(join(input.stagingDir, "workflows"))) || manifest.workflows !== undefined) note("workflows", "workflows");
  const experimental = isObject(manifest.experimental) ? manifest.experimental : {};
  if (existsSync(join(input.stagingDir, "monitors", "monitors.json")) || experimental.monitors !== undefined || manifest.monitors !== undefined) note("monitors", "monitors");
  if ((await isDir(join(input.stagingDir, "themes"))) || experimental.themes !== undefined || manifest.themes !== undefined) note("themes", "themes");
  if (await isDir(join(input.stagingDir, "bin"))) note("bin", "bin/ (Bash PATH 추가)");
  if (manifest.userConfig !== undefined) note("user-config", "userConfig (사용자 입력 설정)");
  if (manifest.channels !== undefined) note("channels", "channels");
  if (manifest.settings !== undefined || existsSync(join(input.stagingDir, "settings.json"))) note("settings", "plugin settings");
  if (Array.isArray(manifest.dependencies) && manifest.dependencies.length > 0) note("dependencies", `plugin 의존성 ${manifest.dependencies.length}개 (자동 설치 안 함)`);
  const pkg = join(input.stagingDir, "package.json");
  if (existsSync(pkg) && !existsSync(join(input.stagingDir, "node_modules"))) {
    try {
      const json = parseJson((await readManifest(pkg)) ?? "{}", "package.json");
      if (isObject(json) && isObject(json.dependencies) && Object.keys(json.dependencies).length > 0) {
        note("npm-dependencies", "package.json 의존성은 설치하지 않습니다 (node_modules 없음)");
      }
    } catch {
      // package.json을 못 읽어도 설치는 계속한다.
    }
  }
  return out;
}

function commandRecord(name: string, raw: string, filePath: string): CommandRecord {
  const parsed = parseMarkdownFrontmatter(raw);
  const converted = convertCommandBody(parsed.body, argumentNamesFrom(parsed.frontmatter.arguments));
  const description = frontmatterString(parsed.frontmatter, "description") ?? firstLine(parsed.body);
  const argumentHint = frontmatterString(parsed.frontmatter, "argument-hint");
  const notes = [...converted.notes];
  if (parsed.frontmatter["allowed-tools"] !== undefined) notes.push("allowed-tools는 무시됩니다 (pi에는 승인 단계가 없음)");
  if (parsed.frontmatter.model !== undefined) notes.push("model 지정은 무시됩니다");
  return {
    name,
    description: description || name,
    ...(argumentHint ? { argumentHint } : {}),
    content: converted.content,
    filePath,
    notes,
  };
}

/** agent frontmatter 중 쓰는 키 (color는 화면 표시용이라 무시해도 알리지 않는다) */
const AGENT_KEYS = new Set(["name", "description", "tools", "color"]);

/** `tools: Read, Grep` 또는 YAML 배열 */
function toolList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = items.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

export function substitutePluginVars(text: string, root: string, dataDir: string, skillDir?: string): string {
  let out = text.split("${CLAUDE_PLUGIN_ROOT}").join(root).split("${CLAUDE_PLUGIN_DATA}").join(dataDir);
  if (skillDir) out = out.split("${CLAUDE_SKILL_DIR}").join(skillDir);
  return out;
}

/** 설치 디렉토리 기준 경로로 SKILL.md·command 파일 안의 Claude 변수를 치환한다 (staging에서 실행). */
export async function rewriteTextFiles(found: DiscoveredComponents, stagingDir: string, finalDir: string, dataDir: string): Promise<void> {
  const done = new Set<string>();
  for (const { path, skillDir } of found.textFiles) {
    if (done.has(path)) continue;
    done.add(path);
    // 링크이거나 staging 밖을 가리키는 파일은 읽지도 쓰지도 않는다.
    const text = await readContainedFile(stagingDir, relative(stagingDir, path), { maxBytes: MAX_CONTENT_BYTES }).catch(() => undefined);
    if (text === undefined) continue;
    const finalSkillDir = skillDir ? join(finalDir, relative(stagingDir, skillDir)) : undefined;
    const next = substitutePluginVars(text, finalDir, dataDir, finalSkillDir);
    if (next !== text) await writeFile(path, next);
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function subdirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const child = join(dir, name);
    if (await isDir(child)) out.push(child);
  }
  return out;
}

/** dir 아래의 .md 파일 (재귀, 이름순). dir이 없으면 빈 배열. */
async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 16 || !(await isDir(dir))) return [];
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const child = join(dir, name);
    const info = await lstat(child);
    if (info.isDirectory()) out.push(...(await markdownFiles(child, depth + 1)));
    else if (info.isFile() && name.toLowerCase().endsWith(".md")) out.push(child);
  }
  return out;
}
