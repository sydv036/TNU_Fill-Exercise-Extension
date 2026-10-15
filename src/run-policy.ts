import type { AnswerDecision, QuizTarget, RunSession } from "./types";

type DecisionPauseRun = Pick<RunSession, "target" | "practiceBatch" | "reviewEveryAnswer">;

export function shouldPauseForDecision(run: DecisionPauseRun, decision: AnswerDecision, confidenceThreshold: number): boolean {
  const isPracticeBatch = run.target.assessmentKind === "practice" && Boolean(run.practiceBatch);
  if (isPracticeBatch) return false;
  return run.target.assessmentKind !== "practice"
    || run.reviewEveryAnswer
    || decision.needsHumanReview
    || decision.confidence < confidenceThreshold;
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
