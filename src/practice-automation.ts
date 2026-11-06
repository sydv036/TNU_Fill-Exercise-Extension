import type { PracticeAutomationState, QuizScore, RunSession } from "./types";

function localizedNumber(value: string): number | undefined {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function scoreFromText(value: string): QuizScore | undefined {
  const matches = [...value.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:\/|out\s+of)\s*(\d+(?:[.,]\d+)?)/gi)];
  const scores = matches.flatMap((match) => {
    const earned = localizedNumber(match[1] ?? "");
    const maximum = localizedNumber(match[2] ?? "");
    if (earned === undefined || maximum === undefined || maximum <= 0 || earned < 0 || earned > maximum + 0.000001) return [];
    return [{ earned, maximum, full: Math.abs(earned - maximum) < 0.000001, label: `${match[1]}/${match[2]}` } satisfies QuizScore];
  });
  return scores.at(-1);
}

export function reviewScore(document: Document): QuizScore | undefined {
  const rows = [...document.querySelectorAll<HTMLElement>("#region-main table tr, main table tr, .quizreviewsummary tr")];
  const candidates = rows
    .filter((row) => {
      const label = row.querySelector<HTMLElement>("th, td")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return /^(điểm|grade)$/i.test(label) || /(^|\s)(điểm|grade)(\s|$)/i.test((row.textContent ?? "").replace(/\s+/g, " "));
    })
    .flatMap((row) => {
      const score = scoreFromText(row.textContent ?? "");
      return score ? [score] : [];
    });
  return candidates.at(-1);
}

export function bestQuizScore(document: Document): QuizScore | undefined {
  const headings = [...document.querySelectorAll<HTMLElement>("#region-main h1, #region-main h2, #region-main h3, main h1, main h2, main h3")];
  for (const heading of headings) {
    const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!/(lần cao nhất|highest grade|best grade)/i.test(text)) continue;
    const score = scoreFromText(text);
    if (score) return score;
  }
  return undefined;
}

export function shouldStopForExistingFullScore(automation: PracticeAutomationState, score?: QuizScore): boolean {
  return Boolean(score?.full && !automation.collectCacheWhenFull);
}

export interface PracticeReviewTransition {
  outcome: "complete" | "retry" | "limit" | "score_missing";
  next?: PracticeAutomationState;
}

export function practiceReviewTransition(
  automation: PracticeAutomationState,
  score: QuizScore | undefined
): PracticeReviewTransition {
  if (!score) return { outcome: "score_missing" };
  const withScore = { ...automation, scoreHistory: [...automation.scoreHistory, score], submitPhase: "reviewing" as const };
  if (score.full) return { outcome: "complete", next: withScore };
  if (automation.attemptNumber >= automation.maxAttempts) return { outcome: "limit", next: withScore };
  return {
    outcome: "retry",
    next: { ...withScore, attemptNumber: automation.attemptNumber + 1, submitPhase: "idle" }
  };
}

export function resetRunForPracticeAttempt(run: RunSession, automation: PracticeAutomationState): RunSession {
  return {
    ...run,
    executionEpoch: crypto.randomUUID(),
    status: "preparing",
    page: 1,
    currentQuestion: 0,
    totalOnPage: 0,
    activeExecution: undefined,
    webUnknownRequestId: undefined,
    webCompletedResponse: undefined,
    processedQuestionIds: [],
    startAnchorUsed: false,
    startAnchorPage: undefined,
    startAnchorIndex: undefined,
    pendingDecision: undefined,
    currentQuestionSnapshot: undefined,
    practiceAutomation: automation,
    message: `Đang chuẩn bị lần làm ${automation.attemptNumber}/${automation.maxAttempts}...`
  };
}
