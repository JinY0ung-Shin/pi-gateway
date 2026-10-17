// 관리 API 응답 형태 (gateway platform 레인과 맞춘다)

export interface LivePrompt {
  name: string | null;
  version: number | null;
  revision: string;
  deployedAt: string;
  deployedBy: string;
  isDefault: boolean;
  content: string;
}

export interface PromptSummary {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  versionCount: number;
  latestAuthor: string;
  charCount: number;
  liveVersion: number | null;
}

export interface PromptVersion {
  version: number;
  content: string;
  message: string;
  author: string;
  createdAt: string;
  sha: string;
}

export interface PromptDetail {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  latestVersion: number;
  liveVersion: number | null;
  versions: PromptVersion[];
}

export interface PromptDeployment {
  id: number;
  at: string;
  action: "deploy" | "rollback" | "reset";
  name: string | null;
  version: number | null;
  actor: string;
  note: string;
  fromName: string | null;
  fromVersion: number | null;
}

export interface PromptList {
  live: LivePrompt;
  prompts: PromptSummary[];
  defaultContent: string;
  variables: string[];
}

export type McpScope = "shared" | "per-user" | "per-session";
export type McpTransport =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers: Record<string, string> };

export interface McpServerConfig {
  id: string;
  displayName?: string;
  description?: string;
  enabled: boolean;
  runIn: "broker" | "sandbox";
  scope: McpScope;
  transport: McpTransport;
  toolAllow?: string[];
  toolDeny?: string[];
  timeoutSec: number;
  source: { kind: "manual" } | { kind: "plugin"; pluginId: string; version: string };
}

export interface SecretInfo {
  name: string;
  setAt: string;
  fingerprint: string;
}

export interface McpServerEntry {
  store: "sandbox" | "broker";
  config: McpServerConfig;
  requiredSecrets: string[];
  secrets?: SecretInfo[];
  missingSecrets?: string[];
  status?: { processes: number; lastError?: string; lastErrorAt?: string };
}

export interface McpServerList {
  servers: McpServerEntry[];
  broker: { configured: boolean; available: boolean; error?: string };
}

export interface ToolSummary {
  name: string;
  description?: string;
}

export interface MarketplaceView {
  name: string;
  url: string;
  ref: string | null;
  commitSha: string;
  description?: string;
  owner?: string;
  pluginCount: number;
  invalidEntries: number;
  addedAt: string;
  refreshedAt: string;
}

export interface CatalogEntry {
  name: string;
  description?: string;
  /** marketplace.json에 적힌 버전 (설치본 plugin.json 버전과 다를 수 있다) */
  listedVersion?: string;
  category?: string;
  tags: string[];
  source: string;
  sourceType: string;
  supported: boolean;
  installed: { id: string; version: string; enabled: boolean } | null;
}

export interface McpRecord {
  name: string;
  id?: string;
  runIn?: "broker" | "sandbox";
  status: "registered" | "unsupported" | "error" | "broker_unavailable" | "needs_preinstall";
  reason?: string;
  requiredSecrets: string[];
  warnings: string[];
}

export interface PluginView {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  installPath: string;
  description?: string;
  source: { type: string; display: string; commit?: string };
  installedAt: string;
  updatedAt: string;
  components: {
    skills: { name: string; description: string; disableModelInvocation: boolean }[];
    commands: { name: string; description: string; argumentHint?: string; notes: string[] }[];
    agents: { name: string; description: string; tools?: string[]; notes: string[] }[];
    unsupported: { kind: string; detail: string }[];
    warnings: string[];
    copySkipped: { path: string; reason: string }[];
  };
  mcp: McpRecord[];
}

export interface StatusView {
  stats: { liveSessions: number; activeTurns: number; queuedTurns: number };
  sandboxes: { items: { key: string; containerName: string; state: string; lastActiveAt?: string; memoryBytes?: number }[]; error?: string };
  process: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; uptimeSeconds: number; nodeVersion: string };
  broker: { configured: boolean };
  plugins: { installed: number; enabled: number };
  prompt: { name: string | null; version: number | null; isDefault: boolean };
}
