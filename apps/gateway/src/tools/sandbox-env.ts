import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { REDACTED, Redactor } from "@pi-gateway/shared";

/**
 * sandbox_env 값을 도구 결과에서 가린다 (broker와 같은 Redactor: 원문·base64·hex·URL·JSON 형태).
 * 모든 도구의 결과·진행 상황·오류에 건다 — bash가 아니어도 (read·grep 등) 값을 파일로 옮겨 읽을 수 있기 때문이다.
 * pi가 JSONL에 쓰고 모델·클라이언트가 받는 것은 가린 결과뿐이다. env는 턴마다 바뀌므로 함수로 받는다.
 * 인자에 `[REDACTED]`가 든 호출은 실행하지 않는다. 모델이 가린 결과를 그대로 옮겨 쓰면 파일의 원래 값이 그 글자로 바뀌기 때문이다.
 */
export function redactSandboxEnv(env: () => Record<string, string>): (tool: ToolDefinition) => ToolDefinition {
  let cached: { env: Record<string, string>; redactor: Redactor } | undefined;
  const redactor = () => {
    const current = env();
    if (cached?.env !== current) cached = { env: current, redactor: new Redactor(Object.values(current)) };
    return cached.redactor;
  };
  return (tool) => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const r = redactor();
      if (Object.keys(env()).length > 0 && JSON.stringify(params).includes(REDACTED)) throw new Error(REDACTED_INPUT);
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate ? (u) => onUpdate(r.redactDeep(u)) : undefined, ctx);
        return r.redactDeep(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const safe = r.redact(message);
        if (safe === message) throw err;
        throw new Error(safe);
      }
    },
  });
}

const REDACTED_INPUT =
  `${REDACTED} is a placeholder for a hidden secret, not its value, so writing it would replace the real value. ` +
  "Leave that text unchanged (edit only the other lines), or use the environment variable (e.g. $NAME) in bash.";
