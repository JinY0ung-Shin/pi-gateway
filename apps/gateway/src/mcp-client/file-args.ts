import { createHash } from "node:crypto";
import { posix } from "node:path";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { FILE_EXTENSIONS } from "../api/request.js";
import type { SandboxHandle } from "../sandbox/client.js";
import { mimeTypeOf } from "../tools/present-file.js";

/**
 * MCP 도구의 파일 인자. 서버가 inputSchema의 property에 `"x-workspace-file": true`를 붙이면 그 인자는 파일이다.
 * - 모델에게는 그 property를 "/workspace 아래 파일의 경로"(문자열)로 보여 준다.
 * - 호출할 때 gateway가 그 경로의 파일을 sandbox에서 읽어 `{filename, mimeType, size, sha256, data}`로 바꿔 넣는다
 *   (data는 base64). 모델은 파일 내용을 인자로 쓰지 않고, 서버는 size·sha256으로 받은 바이트를 확인할 수 있다.
 * 표시가 없는 인자에는 손대지 않는다. 표시는 `properties`와 `items`를 따라 들어간 곳에서만 본다.
 * /workspace 밖의 경로, 심볼릭 링크를 거치는 경로, 디렉토리, 빈 파일, 받지 않는 형식은 거절한다 (호출하지 않는다).
 */

export const FILE_ARG_KEYWORD = "x-workspace-file";
/** 한 번의 호출에 실을 수 있는 파일 수와 합계 크기 (broker의 요청 한도가 이 크기의 base64를 받는다) */
export const MAX_FILE_ARGS = 10;
export const MAX_FILE_ARG_BYTES = 28 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isFileArg = (schema: Json): boolean => schema[FILE_ARG_KEYWORD] === true;

const PATH_NOTE = `Absolute path of a file under ${SANDBOX_WORKSPACE} (${FILE_EXTENSIONS.join(", ")}). The file itself is sent: give the path, never the file's content.`;

/** 모델에게 보여 줄 schema: 파일 인자는 경로 문자열이 된다. 표시가 없으면 받은 객체를 그대로 돌려준다. */
export function modelSchema<T>(schema: T): T {
  if (!isObject(schema)) return schema;
  if (isFileArg(schema)) {
    const description = typeof schema.description === "string" && schema.description.trim() ? `${schema.description.trim()} ` : "";
    return { type: "string", description: `${description}${PATH_NOTE}` } as T;
  }
  let changed = false;
  const out: Json = { ...schema };
  if (isObject(schema.properties)) {
    const properties: Json = {};
    for (const [key, sub] of Object.entries(schema.properties)) {
      properties[key] = modelSchema(sub);
      if (properties[key] !== sub) changed = true;
    }
    out.properties = properties;
  }
  if (isObject(schema.items)) {
    out.items = modelSchema(schema.items);
    if (out.items !== schema.items) changed = true;
  }
  return changed ? (out as T) : schema;
}

/** `/workspace` 아래의 진짜 파일인지 본다. 경로의 어느 조각이든 심볼릭 링크면 거절한다 (밖으로 나가는 길을 따라가지 않는다). */
async function workspaceFile(sandbox: Pick<SandboxHandle, "stat">, given: string, signal?: AbortSignal): Promise<{ path: string; size: number }> {
  const path = posix.resolve(SANDBOX_WORKSPACE, given.trim());
  if (!path.startsWith(`${SANDBOX_WORKSPACE}/`)) throw new Error(`'${given}' is outside ${SANDBOX_WORKSPACE}: only a file of the workspace can be sent.`);
  const ext = posix.extname(path).slice(1).toLowerCase();
  if (!FILE_EXTENSIONS.includes(ext)) {
    throw new Error(`'${given}' cannot be sent: only ${FILE_EXTENSIONS.map((e) => `.${e}`).join(", ")} files can.`);
  }
  const segments = path.slice(SANDBOX_WORKSPACE.length + 1).split("/");
  let current = SANDBOX_WORKSPACE;
  for (const [i, segment] of segments.entries()) {
    current = `${current}/${segment}`;
    const st = await sandbox.stat(current, signal);
    if (!st.exists) throw new Error(`'${given}' does not exist.`);
    const last = i === segments.length - 1;
    if (st.kind === "symlink") throw new Error(`'${given}' goes through a symbolic link (${current}): give the path of the real file.`);
    if (!last && st.kind !== "dir") throw new Error(`'${given}' does not exist.`);
    if (last) {
      if (st.kind !== "file") throw new Error(`'${given}' is not a regular file.`);
      if (!st.size) throw new Error(`'${given}' is empty.`);
      return { path: current, size: st.size };
    }
  }
  throw new Error(`'${given}' is not a file.`);
}

/**
 * args에서 파일 인자(경로)를 파일 객체로 바꾼 사본. 하나라도 거절되면 던진다 (그 호출은 보내지 않는다).
 * schema는 서버가 준 원래 inputSchema다.
 */
export async function fillFileArgs(
  schema: unknown,
  args: Json,
  sandbox: Pick<SandboxHandle, "stat" | "readFile">,
  signal?: AbortSignal,
): Promise<Json> {
  let count = 0;
  let bytes = 0;
  const tooLarge = () => new Error(`The files of one call can be at most ${MAX_FILE_ARG_BYTES / (1024 * 1024)} MiB together.`);
  const load = async (value: unknown): Promise<Json> => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`A file argument takes the path of a file under ${SANDBOX_WORKSPACE} (a string).`);
    if (++count > MAX_FILE_ARGS) throw new Error(`At most ${MAX_FILE_ARGS} files can be sent in one call.`);
    const file = await workspaceFile(sandbox, value, signal);
    if (bytes + file.size > MAX_FILE_ARG_BYTES) throw tooLarge();
    // 확인한 뒤에 파일이 커졌어도 남은 한도까지만 읽는다.
    const { content, truncated } = await sandbox.readFile(file.path, MAX_FILE_ARG_BYTES - bytes);
    if (truncated) throw tooLarge();
    if (content.length === 0) throw new Error(`'${value}' is empty.`);
    bytes += content.length;
    return {
      filename: posix.basename(file.path),
      mimeType: mimeTypeOf(file.path),
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      data: content.toString("base64"),
    };
  };
  const walk = async (sub: unknown, value: unknown): Promise<unknown> => {
    if (value === undefined || value === null || !isObject(sub)) return value;
    if (isFileArg(sub)) return load(value);
    if (isObject(sub.properties) && isObject(value)) {
      const out: Json = { ...value };
      for (const [key, child] of Object.entries(sub.properties)) {
        if (key in value) out[key] = await walk(child, value[key]);
      }
      return out;
    }
    if (isObject(sub.items) && Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(sub.items, item));
      return out;
    }
    return value;
  };
  return (await walk(schema, args)) as Json;
}
