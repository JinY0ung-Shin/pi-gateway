import {
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE } from "@pi-gateway/shared";
import { createSandboxBashTool } from "../bash.js";
import { createSandboxGrepTool } from "../grep.js";
import { createPresentFileTool } from "../present-file.js";
import type { ToolProvider } from "../provider.js";
import { createRemoteFs, mapHomePath, PathNamespace } from "../remote-fs.js";

/**
 * sandbox provider — 파일·명령 도구 8개. 전부 사용자 sandbox 컨테이너 안에서 실행된다.
 * - read/write/edit: pi 정의 + 원격 operations + 세션별 경로 이름공간 (remote-fs.ts 설명 참고)
 * - ls/find: pi 정의 + 원격 operations (pi가 로컬 파일시스템을 보지 않는다)
 * - bash/grep: pi 스키마에 execute만 sandbox 실행으로 바꾼 것
 * - present_file: workspace 파일을 클라이언트에 보여준다 (present-file.ts)
 * read_only 세션에는 sandbox를 바꾸거나 명령을 실행하는 write/edit/bash를 주지 않는다.
 */

function preparePath(def: ToolDefinition, map: (path: string) => string): ToolDefinition["prepareArguments"] {
  const original = def.prepareArguments;
  return (args: unknown) => {
    const prepared = (original ? original(args) : args) as Record<string, unknown>;
    if (prepared && typeof prepared === "object" && typeof prepared.path === "string") {
      return { ...prepared, path: map(prepared.path) } as never;
    }
    return prepared as never;
  };
}

/** `~` 경로를 sandbox HOME으로 바꾼다 (ls, find). grep은 execute에서 sandbox 경로로 바꾼다. */
function withHomeMapping(def: ToolDefinition): ToolDefinition {
  return { ...def, prepareArguments: preparePath(def, mapHomePath) };
}

/**
 * pi에는 이름공간 경로만 보여주고, 결과·오류·진행 상황에서는 접두사를 지워 모델이 원래 경로를 본다.
 * 경로는 execute 안에서 바꾼다: pi는 prepareArguments 결과로 인자를 검증하고, 검증 오류에
 * 그 인자를 그대로 싣기 때문이다 (prepareArguments에서 바꾸면 접두사가 오류 메시지로 새어 나간다).
 */
function withNamespace(def: ToolDefinition, ns: PathNamespace): ToolDefinition {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = params as Record<string, unknown>;
      const wrapped = typeof args?.path === "string" ? { ...args, path: ns.wrap(args.path) } : args;
      try {
        const result = await def.execute(toolCallId, wrapped as never, signal, onUpdate ? (u) => onUpdate(ns.strip(u)) : undefined, ctx);
        return ns.strip(result);
      } catch (err) {
        throw new Error(ns.strip(err instanceof Error ? err.message : String(err)));
      }
    },
  };
}

export function createSandboxToolProvider(): ToolProvider {
  return {
    id: "sandbox",
    async createTools(ctx) {
      const ns = new PathNamespace();
      const fs = createRemoteFs(ctx.sandbox, (p) => ns.unwrap(p));
      const cwd = SANDBOX_WORKSPACE;
      return [
        withNamespace(createReadToolDefinition(cwd, { operations: fs.read }) as ToolDefinition, ns),
        ...(ctx.readOnly
          ? []
          : [
              withNamespace(createWriteToolDefinition(cwd, { operations: fs.write }) as ToolDefinition, ns),
              withNamespace(createEditToolDefinition(cwd, { operations: fs.edit }) as ToolDefinition, ns),
            ]),
        withHomeMapping(createLsToolDefinition(cwd, { operations: fs.ls }) as ToolDefinition),
        withHomeMapping(createFindToolDefinition(cwd, { operations: fs.find }) as ToolDefinition),
        ...(ctx.readOnly ? [] : [createSandboxBashTool(ctx.sandbox, ctx.sandboxEnv)]),
        createSandboxGrepTool(ctx.sandbox),
        createPresentFileTool(ctx.sandbox) as unknown as ToolDefinition,
      ];
    },
  };
}
