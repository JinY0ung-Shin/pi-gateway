import type { RunResult } from "./run.js";
import type { Episode, Label } from "./store.js";

/** 실행 결과를 Markdown으로 쓴다. stdout으로 나가 호스트의 파일이 되고, REPORT_FILE에도 남아 관리 화면이 보여 준다. */

/** mining이 마지막 보고서를 두는 곳 (compose의 mining-data 볼륨. gateway는 읽기 전용으로 mount한다) */
export const REPORT_FILE = "/mining/report.md";

const STATUS: Record<RunResult["status"], string> = {
  completed: "완료",
  time_limit: "시간 상한에서 멈춤 (다음 실행이 이어 간다)",
  aborted: "중단 (LLM 호출이 연달아 실패했다)",
};

const DAY_MS = 86_400_000;
/** 보고서에 싣는 이번 실행의 에피소드 수 */
const MAX_EPISODES = 200;
/** 프로세스마다 보여 주는 예시 목표 수 */
const EXAMPLES = 3;
const UNLABELED = "미분류";

/** LLM이 쓴 글을 보고서에 그대로 넣지 않는다: 한 줄로 만들고, 링크·이미지·HTML·표로 읽힐 기호를 막는다. */
export const plain = (text: string) => text.replace(/\s+/g, " ").replace(/[\\`*_[\]()<>!|#]/g, "\\$&");

const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);

export interface ReportInput {
  at: Date;
  model: string;
  result: RunResult;
  labels: Label[];
  /** 최근 30일에 끝난 에피소드 */
  recent: Episode[];
  /** 이번 실행에서 만들거나 고친 에피소드 */
  touched: Episode[];
  /** 세션 id → 사용자 */
  users: ReadonlyMap<string, string>;
}

export function renderReport(input: ReportInput): string {
  const { result, labels, recent } = input;
  const weekAgo = new Date(input.at.getTime() - 7 * DAY_MS).toISOString();
  const userOf = (e: Episode) => input.users.get(e.sessionId) ?? "(알 수 없음)";
  const nameOf = new Map(labels.map((l) => [l.id, l.name]));
  const labelName = (e: Episode) => (e.labelId === null ? UNLABELED : (nameOf.get(e.labelId) ?? UNLABELED));
  const of = (label: Label) => recent.filter((e) => e.labelId === label.id);
  const labeled = recent.filter((e) => e.labelId !== null);
  const byCount = [...labels].sort((a, b) => of(b).length - of(a).length || a.id - b.id);

  const lines = [
    "# 프로세스 마이닝 보고서",
    "",
    `- 생성: ${input.at.toISOString()} (UTC). "7일"과 "30일"은 이 시각 기준이다.`,
    `- 결과: ${STATUS[result.status]}`,
    `- 끝까지 읽은 세션 ${result.processed}개, 실패 ${result.failed}개, 남은 대상 ${result.remaining}개`,
    `- 모델: ${plain(input.model)}`,
  ];

  const fresh = labels.filter((l) => l.createdAt >= weekAgo);
  lines.push("", "## 최근 7일에 새로 생긴 프로세스", "");
  lines.push(...(fresh.length > 0 ? fresh.map((l) => `- ${plain(l.name)}: ${plain(l.criteria)}`) : ["없음"]));

  lines.push("", `## 프로세스 목록 (${labels.length}개)`);
  if (labels.length === 0) lines.push("", "아직 없다. 미분류 에피소드가 쌓이면 다음 실행에서 찾는다.");
  for (const label of byCount) {
    const episodes = of(label);
    lines.push(
      "",
      `### ${plain(label.name)}`,
      "",
      `- 기준: ${plain(label.criteria)}`,
      `- 건수: 7일 ${episodes.filter((e) => e.endedAt >= weekAgo).length}건, 30일 ${episodes.length}건`,
      `- 사용자: ${new Set(episodes.map(userOf)).size}명`,
      `- 대표 흐름: ${label.flow ? label.flow.map(plain).join(" → ") : "아직 없음"}`,
      ...episodes.slice(0, EXAMPLES).map((e) => `- 예시: ${plain(e.goal)}`),
    );
  }

  const biggest = byCount[0] ? of(byCount[0]).length : 0;
  lines.push(
    "",
    "## 지표 (최근 30일)",
    "",
    `- 미분류율: ${percent(recent.length - labeled.length, recent.length)} (에피소드 ${recent.length}건 중 ${recent.length - labeled.length}건). 높으면 라벨이 실제 사용을 못 따라간다.`,
    `- 최대 라벨 점유율: ${percent(biggest, labeled.length)}. 높으면 라벨이 뭉뚱그려졌다.`,
    `- 라벨 수: ${labels.length}개`,
    "",
    "이 숫자들은 라벨이 맞는지를 재지 못한다. 위의 예시를 읽어 확인한다.",
  );

  // 사용자별: 최근 30일의 작업 분포와, 이번 실행에서 뽑은 에피소드
  const shown = input.touched.slice(0, MAX_EPISODES);
  const people = [...new Set(recent.map(userOf))].sort((a, b) => recent.filter((e) => userOf(e) === b).length - recent.filter((e) => userOf(e) === a).length || a.localeCompare(b));
  lines.push("", `## 사용자별 (${people.length}명)`);
  if (input.touched.length > shown.length) lines.push("", `이번 실행의 에피소드 ${input.touched.length}건 중 처음 ${shown.length}건만 싣는다.`);
  for (const user of people) {
    const mine = recent.filter((e) => userOf(e) === user);
    const counts = new Map<string, number>();
    for (const e of mine) counts.set(labelName(e), (counts.get(labelName(e)) ?? 0) + 1);
    const spread = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${plain(name)} ${n}건`);
    lines.push("", `### ${plain(user)}`, "", `- 최근 30일 ${mine.length}건: ${spread.join(", ")}`);
    for (const e of shown.filter((x) => userOf(x) === user)) {
      lines.push("", `#### ${plain(e.goal)}`, "", `- 라벨: ${plain(labelName(e))}`, ...e.steps.map((s, i) => `${i + 1}. ${plain(s)}`));
    }
  }
  return `${lines.join("\n")}\n`;
}
