import { z } from "zod";

/**
 * gateway ↔ sandboxd 계약.
 *
 * - 모든 요청에 `Authorization: Bearer <internal JWT, aud=AUD_SANDBOXD>`가 필요하다.
 *   sandboxd는 본문의 `user`가 토큰의 `sub`와 같은지 확인한다.
 * - 경로는 sandbox 컨테이너 안의 경로다. 상대 경로는 `/workspace` 기준이다.
 *   컨테이너 경계가 곧 접근 범위이므로 sandboxd는 경로를 따로 제한하지 않는다.
 * - 대상 사용자의 컨테이너가 없거나 멈춰 있으면 sandboxd가 먼저 만들거나 시작한다.
 * - 오류 응답은 `{ error: { code, message } }` 형식이고 code는 `SandboxErrorCode` 중 하나다.
 */

export const SANDBOX_WORKSPACE = "/workspace";
export const SANDBOX_HOME = "/workspace/.home";
export const SANDBOX_PLUGINS_DIR = "/opt/plugins";
export const SANDBOX_TMP = "/tmp";
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

export const SANDBOXD_ROUTES = {
  health: "/healthz",
  ensure: "/v1/sandboxes/ensure",
  list: "/v1/sandboxes",
  exec: "/v1/exec",
  fsRead: "/v1/fs/read",
  fsWrite: "/v1/fs/write",
  fsStat: "/v1/fs/stat",
  fsList: "/v1/fs/list",
  fsMkdir: "/v1/fs/mkdir",
  fsGlob: "/v1/fs/glob",
  /** WebSocket. 장기 실행 stdio 프로세스 (sandbox 실행 MCP 서버) */
  attach: "/v1/attach",
} as const;

export const SandboxErrorCode = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "is_directory",
  "not_directory",
  "too_large",
  "permission_denied",
  "sandbox_unavailable",
  "timeout",
  "internal",
]);
export type SandboxErrorCode = z.infer<typeof SandboxErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

const principal = z.string().min(1).max(200);
const sandboxPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "path must not contain NUL");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const MiB = 1024 * 1024;

// ── 컨테이너 수명주기 ────────────────────────────────────────────────

/** POST /v1/sandboxes/ensure — 컨테이너를 만들거나 시작한다. */
export const EnsureSandboxRequest = z.object({ user: principal });
export type EnsureSandboxRequest = z.input<typeof EnsureSandboxRequest>;

export const SandboxState = z.enum(["running", "stopped", "missing"]);
export const SandboxInfo = z.object({
  key: z.string(),
  containerName: z.string(),
  state: SandboxState,
  /** 이번 호출에서 새로 만들었는지 (ensure 응답에만 있음) */
  created: z.boolean().optional(),
  lastActiveAt: z.string().optional(),
  memoryBytes: z.number().optional(),
});
export type SandboxInfo = z.infer<typeof SandboxInfo>;

/** GET /v1/sandboxes — 관리용 목록. 이 요청의 토큰 sub는 `_admin`이다. */
export const ListSandboxesResponse = z.object({ sandboxes: z.array(SandboxInfo) });
export const ADMIN_PRINCIPAL = "_admin";

// ── 명령 실행 ────────────────────────────────────────────────────────

/**
 * POST /v1/exec — 응답은 `application/x-ndjson` 스트림이다 (한 줄에 ExecEvent 하나).
 * - sandboxd는 argv를 셸 해석 없이 그대로 실행한다. 셸이 필요하면 `["bash", "-c", cmd]`로 보낸다.
 * - 프로세스는 새 process group으로 띄운다. 클라이언트가 요청을 끊거나 timeout이 되면
 *   group 전체에 SIGTERM을 보내고, 5초 뒤에도 살아 있으면 SIGKILL을 보낸다.
 * - env는 sandbox 기본 env(HOME, PATH 등) 위에 덮어쓴다. gateway는 allowlist된 값만 보낸다.
 * - 출력이 maxOutputBytes를 넘으면 나머지 chunk는 버리고 exit 이벤트에 truncated=true를 준다.
 */
export const ExecRequest = z.object({
  user: principal,
  argv: z.array(z.string()).min(1).max(4096),
  cwd: sandboxPath.default(SANDBOX_WORKSPACE),
  env: z.record(envName, z.string()).default({}),
  /** base64. 다 쓰고 나면 stdin을 닫는다. 없으면 바로 닫는다. */
  stdin: z.string().optional(),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
  maxOutputBytes: z.number().int().min(1).max(64 * MiB).default(8 * MiB),
});
export type ExecRequest = z.input<typeof ExecRequest>;

export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), execId: z.string() }),
  /** data는 base64 */
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    truncated: z.boolean(),
    durationMs: z.number(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

// ── 파일 ────────────────────────────────────────────────────────────

export const FileKind = z.enum(["file", "dir", "symlink", "other"]);
export type FileKind = z.infer<typeof FileKind>;

/** POST /v1/fs/read — 없으면 404 not_found, 디렉토리면 400 is_directory. 심볼릭 링크는 따라간다 (컨테이너 안). */
export const FsReadRequest = z.object({
  user: principal,
  path: sandboxPath,
  maxBytes: z.number().int().min(0).max(64 * MiB).default(32 * MiB),
});
export type FsReadRequest = z.input<typeof FsReadRequest>;
export const FsReadResponse = z.object({
  size: z.number(),
  /** base64 */
  content: z.string(),
  truncated: z.boolean(),
});
export type FsReadResponse = z.infer<typeof FsReadResponse>;

/** POST /v1/fs/write — 덮어쓴다. mkdirs면 상위 디렉토리를 만든다. */
export const FsWriteRequest = z.object({
  user: principal,
  path: sandboxPath,
  /** base64 */
  content: z.string(),
  mkdirs: z.boolean().default(true),
});
export type FsWriteRequest = z.input<typeof FsWriteRequest>;
export const FsWriteResponse = z.object({ size: z.number() });

/** POST /v1/fs/stat — 없으면 200 `{exists:false}`. 심볼릭 링크 자체를 본다 (lstat). */
export const FsStatRequest = z.object({ user: principal, path: sandboxPath });
export type FsStatRequest = z.input<typeof FsStatRequest>;
export const FsStatResponse = z.object({
  exists: z.boolean(),
  kind: FileKind.optional(),
  size: z.number().optional(),
  mtimeMs: z.number().optional(),
  /** 심볼릭 링크를 따라갔을 때 디렉토리인지 (ls/read 판단용) */
  targetIsDir: z.boolean().optional(),
});
export type FsStatResponse = z.infer<typeof FsStatResponse>;

/** POST /v1/fs/list — 이름순. 없으면 404, 파일이면 400 not_directory. */
export const FsListRequest = z.object({ user: principal, path: sandboxPath });
export type FsListRequest = z.input<typeof FsListRequest>;
export const FsListResponse = z.object({
  entries: z.array(z.object({ name: z.string(), kind: FileKind })),
});
export type FsListResponse = z.infer<typeof FsListResponse>;

/** POST /v1/fs/mkdir */
export const FsMkdirRequest = z.object({
  user: principal,
  path: sandboxPath,
  recursive: z.boolean().default(true),
});
export type FsMkdirRequest = z.input<typeof FsMkdirRequest>;

/** POST /v1/fs/glob — 결과는 절대 경로, 이름순. .gitignore는 존중한다 (fd 동작). */
export const FsGlobRequest = z.object({
  user: principal,
  cwd: sandboxPath.default(SANDBOX_WORKSPACE),
  pattern: z.string().min(1).max(1024),
  ignore: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100_000).default(1000),
});
export type FsGlobRequest = z.input<typeof FsGlobRequest>;
export const FsGlobResponse = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
export type FsGlobResponse = z.infer<typeof FsGlobResponse>;

// ── 장기 실행 프로세스 (WebSocket) ───────────────────────────────────

/**
 * WS /v1/attach — Authorization 헤더로 인증한다.
 * 1. 클라이언트가 첫 text frame으로 AttachStart를 보낸다.
 * 2. 서버가 `{type:"started"}`를 보낸다.
 * 3. 이후 stdout은 binary frame, stdin도 binary frame이다. stderr·종료·오류는 text frame(JSON)이다.
 * 4. 클라이언트가 연결을 닫으면 process group에 SIGTERM, 5초 뒤 SIGKILL을 보낸다.
 *    프로세스가 끝나면 서버가 exit 메시지를 보내고 연결을 닫는다.
 */
export const AttachStart = z.object({
  type: z.literal("start"),
  user: principal,
  argv: z.array(z.string()).min(1).max(4096),
  cwd: sandboxPath.default(SANDBOX_WORKSPACE),
  env: z.record(envName, z.string()).default({}),
});
export type AttachStart = z.input<typeof AttachStart>;

export const AttachServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), procId: z.string() }),
  /** base64 */
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().int().nullable(), signal: z.string().nullable() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type AttachServerMessage = z.infer<typeof AttachServerMessage>;
