import type { AnswerDecision, QuizTarget, RunSession, UncertainMode } from "./types";

export function questionStartIndex(run: Pick<RunSession, "mode" | "startAnchorUsed" | "startAnchorPage" | "startAnchorIndex">, page: number, visibleIndex: number): number {
  if (run.mode !== "from_current") return 0;
  if (!run.startAnchorUsed) return visibleIndex;
  return run.startAnchorPage === page ? run.startAnchorIndex ?? 0 : 0;
}

type DecisionPauseRun = Pick<RunSession, "target" | "practiceBatch" | "reviewEveryAnswer">;

export function shouldPauseForDecision(
  run: DecisionPauseRun,
  decision: AnswerDecision,
  confidenceThreshold: number,
  uncertainMode: UncertainMode
): boolean {
  const isPracticeBatch = run.target.assessmentKind === "practice" && Boolean(run.practiceBatch);
  if (isPracticeBatch) return false;
  return run.target.assessmentKind !== "practice"
    || run.reviewEveryAnswer
    || !decision.selectedOptionIds.length
    || (uncertainMode === "ask" && (decision.needsHumanReview || decision.confidence < confidenceThreshold));
}

export interface PracticeBatchReviewStep {
  nextIndex: number;
  nextTarget?: QuizTarget;
  batchCompleted: boolean;
}

export function practiceBatchReviewStep(
  run: Pick<RunSession, "practiceBatch">,
  reviewComplete: boolean
): PracticeBatchReviewStep | undefined {
  if (!run.practiceBatch || !reviewComplete) return undefined;
  const nextIndex = run.practiceBatch.currentIndex + 1;
  const nextTarget = run.practiceBatch.targets[nextIndex];
  return { nextIndex, nextTarget, batchCompleted: !nextTarget };
}
