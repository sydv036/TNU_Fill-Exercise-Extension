// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bestQuizScore, practiceReviewTransition, reviewScore, scoreFromText, shouldStopForExistingFullScore } from "../src/practice-automation";
import type { PracticeAutomationState } from "../src/types";

const automation: PracticeAutomationState = {
  enabled: true,
  autoSubmit: false,
  collectCacheWhenFull: false,
  maxAttempts: 5,
  attemptNumber: 1,
  webRetryCount: 2,
  scoreHistory: [],
  submitPhase: "reviewing"
};

describe("practice full-score automation", () => {
  it("parses Vietnamese and English score formats", () => {
    expect(scoreFromText("Điểm 9,33 / 10,00")).toMatchObject({ earned: 9.33, maximum: 10, full: false });
    expect(scoreFromText("Grade 10.00 out of 10.00")).toMatchObject({ earned: 10, maximum: 10, full: true });
    expect(scoreFromText("Điểm không hợp lệ")).toBeUndefined();
  });

  it("uses the final grade row from a Moodle review page", () => {
    document.body.innerHTML = `<main id="region-main"><table><tr><td>Điểm</td><td>15,00/15,00</td></tr><tr><td>Điểm</td><td>10,00 out of 10,00 (100%)</td></tr></table></main>`;
    expect(reviewScore(document)).toMatchObject({ earned: 10, maximum: 10, full: true });
  });

  it("detects an existing full best grade before starting another attempt", () => {
    document.body.innerHTML = `<main id="region-main"><h3>Lần cao nhất: 10,00 / 10,00.</h3></main>`;
    expect(bestQuizScore(document)).toMatchObject({ full: true, maximum: 10 });
  });

  it("can run an already-completed practice again specifically to collect cache", () => {
    const full = { earned: 10, maximum: 10, full: true, label: "10/10" };
    expect(shouldStopForExistingFullScore(automation, full)).toBe(true);
    expect(shouldStopForExistingFullScore({ ...automation, collectCacheWhenFull: true }, full)).toBe(false);
  });

  it("retries, completes, stops at the limit, and refuses to loop without a score", () => {
    expect(practiceReviewTransition(automation, { earned: 9.33, maximum: 10, full: false, label: "9,33/10" })).toMatchObject({ outcome: "retry", next: { attemptNumber: 2 } });
    expect(practiceReviewTransition(automation, { earned: 10, maximum: 10, full: true, label: "10/10" })).toMatchObject({ outcome: "complete" });
    expect(practiceReviewTransition({ ...automation, attemptNumber: 5 }, { earned: 9, maximum: 10, full: false, label: "9/10" })).toMatchObject({ outcome: "limit" });
    expect(practiceReviewTransition(automation, undefined)).toEqual({ outcome: "score_missing" });
  });
});
