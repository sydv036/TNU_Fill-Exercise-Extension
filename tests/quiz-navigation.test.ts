import { describe, expect, it } from "vitest";
import { isAttemptForTarget, isReviewForTarget, nextReviewPageUrl, quizModuleId } from "../src/quiz-navigation";

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("quiz navigation identity", () => {
  const target = "https://tnu.aum.edu.vn/mod/quiz/view.php?id=500414";

  it("maps view, attempt and review URLs to the same Moodle module", () => {
    expect(quizModuleId(target)).toBe("500414");
    expect(isAttemptForTarget("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=12&cmid=500414&page=1", target)).toBe(true);
    expect(isReviewForTarget("https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414", target)).toBe(true);
  });

  it("rejects from-current when the open attempt belongs to another quiz", () => {
    expect(isAttemptForTarget("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=99&cmid=999999", target)).toBe(false);
    expect(isAttemptForTarget("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=99", target)).toBe(false);
  });

  it("finds only the next review page of the same quiz", () => {
    const current = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=0";
    expect(nextReviewPageUrl(doc('<a class="mod_quiz-next-nav" href="/mod/quiz/review.php?attempt=12&cmid=500414&page=1">Tiếp</a>'), current))
      .toBe("https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=1");
    expect(nextReviewPageUrl(doc('<a rel="next" href="/mod/quiz/review.php?attempt=99&cmid=7&page=1">Tiếp</a>'), current)).toBeUndefined();
  });
});
