import { describe, expect, it } from "vitest";
import { practiceBatchReviewStep, questionStartIndex, shouldPauseForDecision } from "../src/run-policy";
import type { AnswerDecision, QuizTarget, RunSession } from "../src/types";

const practiceTarget: QuizTarget = {
  id: "practice-1",
  courseId: "course-1",
  courseName: "Môn học",
  category: "Ngành chung",
  week: "Tuần 2",
  name: "Bài luyện tập 1",
  url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=1",
  assessmentKind: "practice",
  source: "auto"
};

const uncertainDecision: AnswerDecision = {
  selectedOptionIds: ["option-c"],
  confidence: 0.4,
  reason: "Cần cân nhắc thêm",
  needsHumanReview: true,
  source: "gemini"
};

function runFor(target: QuizTarget, batch = false, reviewEveryAnswer = false): Pick<RunSession, "target" | "practiceBatch" | "reviewEveryAnswer"> {
  return {
    target,
    reviewEveryAnswer,
    practiceBatch: batch ? { targets: [practiceTarget], currentIndex: 0 } : undefined
  };
}

describe("answer pause policy", () => {
  it("resumes from the original anchor on the first page and from the beginning on later pages", () => {
    expect(questionStartIndex({ mode: "from_current", startAnchorUsed: false }, 2, 4)).toBe(4);
    expect(questionStartIndex({ mode: "from_current", startAnchorUsed: true, startAnchorPage: 2, startAnchorIndex: 4 }, 2, 0)).toBe(4);
    expect(questionStartIndex({ mode: "from_current", startAnchorUsed: true, startAnchorPage: 2, startAnchorIndex: 4 }, 3, 0)).toBe(0);
    expect(questionStartIndex({ mode: "from_start", startAnchorUsed: false }, 2, 4)).toBe(0);
  });
  it("runs a practice cache batch straight through despite low-confidence Gemini output", () => {
    expect(shouldPauseForDecision(runFor(practiceTarget, true), uncertainDecision, 0.9, "ask")).toBe(false);
  });

  it("auto-applies a valid uncertain answer in self-reasoning mode", () => {
    expect(shouldPauseForDecision(runFor(practiceTarget), uncertainDecision, 0.9, "reason")).toBe(false);
  });

  it("pauses an ordinary practice run only when Ask me is selected", () => {
    expect(shouldPauseForDecision(runFor(practiceTarget), uncertainDecision, 0.9, "ask")).toBe(true);
  });

  it("honors the explicit stop-every-question option in self-reasoning mode", () => {
    expect(shouldPauseForDecision(runFor(practiceTarget, false, true), { ...uncertainDecision, confidence: 1, needsHumanReview: false }, 0.9, "reason")).toBe(true);
  });

  it("does not try to apply an empty answer in self-reasoning mode", () => {
    expect(shouldPauseForDecision(runFor(practiceTarget), { ...uncertainDecision, selectedOptionIds: [] }, 0.9, "reason")).toBe(true);
  });

  it("never weakens confirmation for a graded assessment", () => {
    const gradedTarget = { ...practiceTarget, id: "graded-1", assessmentKind: "graded" as const };
    expect(shouldPauseForDecision(runFor(gradedTarget, true), { ...uncertainDecision, confidence: 1, needsHumanReview: false }, 0.9, "reason")).toBe(true);
  });
});

describe("practice batch review policy", () => {
  const secondTarget = { ...practiceTarget, id: "practice-2", name: "Bài luyện tập 2", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=2" };
  const run = { practiceBatch: { targets: [practiceTarget, secondTarget], currentIndex: 0 } };

  it("does not advance the batch from an intermediate review page", () => {
    expect(practiceBatchReviewStep(run, false)).toBeUndefined();
  });

  it("advances only after the final review page, even when that page saved no answers", () => {
    expect(practiceBatchReviewStep(run, true)).toMatchObject({ nextIndex: 1, nextTarget: secondTarget, batchCompleted: false });
    expect(practiceBatchReviewStep({ practiceBatch: { ...run.practiceBatch, currentIndex: 1 } }, true))
      .toEqual({ nextIndex: 2, nextTarget: undefined, batchCompleted: true });
  });
});
