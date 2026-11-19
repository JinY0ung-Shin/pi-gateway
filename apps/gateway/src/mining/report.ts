import type { RunResult } from "./run.js";
import type { Episode } from "./store.js";

/** 실행 결과를 Markdown으로 쓴다 (stdout으로 나가 호스트의 파일이 된다). */

const STATUS: Record<RunResult["status"], string> = {
  completed: "완료",
  time_limit: "시간 상한에서 멈춤 (다음 실행이 이어 간다)",
  aborted: "중단 (LLM 호출이 연달아 실패했다)",
};

/** 보고서에 싣는 에피소드 수 */
const MAX_EPISODES = 200;

/** LLM이 쓴 글을 보고서에 그대로 넣지 않는다: 한 줄로 만들고, 링크·이미지·HTML·표로 읽힐 기호를 막는다. */
export const plain = (text: string) => text.replace(/\s+/g, " ").replace(/[\\`*_[\]()<>!|#]/g, "\\$&");

/** users: 세션 id → 사용자. 에피소드를 사용자별로 묶는 데 쓴다 (에피소드가 많은 사용자부터). */
export function renderReport(input: { at: Date; model: string; result: RunResult; episodes: Episode[]; users: ReadonlyMap<string, string> }): string {
  const { result } = input;
  const shown = input.episodes.slice(0, MAX_EPISODES);
  const byUser = new Map<string, Episode[]>();
  for (const e of shown) {
    const user = input.users.get(e.sessionId) ?? "(알 수 없음)";
    byUser.set(user, [...(byUser.get(user) ?? []), e]);
  }
  const lines = [
    "# 프로세스 마이닝 보고서 (1단계: 추출)",
    "",
    `- 생성: ${input.at.toISOString()} (UTC)`,
    `- 결과: ${STATUS[result.status]}`,
    `- 끝까지 읽은 세션 ${result.processed}개, 실패 ${result.failed}개, 남은 대상 ${result.remaining}개`,
    `- 모델: ${plain(input.model)}`,
    "",
    `## 이번 실행에서 뽑은 에피소드 (${input.episodes.length}건, 사용자 ${byUser.size}명${input.episodes.length > shown.length ? `, 처음 ${shown.length}건만 표시` : ""})`,
  ];
  for (const [user, episodes] of [...byUser].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push("", `### ${plain(user)} (${episodes.length}건)`);
    for (const e of episodes) lines.push("", `#### ${plain(e.goal)}`, "", ...e.steps.map((s, i) => `${i + 1}. ${plain(s)}`));
  }
  return `${lines.join("\n")}\n`;
}
