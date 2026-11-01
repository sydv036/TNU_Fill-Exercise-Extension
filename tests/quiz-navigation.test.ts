import { describe, expect, it } from "vitest";
import { isAttemptForTarget, isReviewForTarget, isSupportedQuizTarget, nextReviewPageUrl, quizModuleId } from "../src/quiz-navigation";

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

  it("accepts only a TNU quiz view as a runnable target", () => {
    expect(isSupportedQuizTarget(target)).toBe(true);
    expect(isSupportedQuizTarget("https://example.com/mod/quiz/view.php?id=500414")).toBe(false);
    expect(isSupportedQuizTarget("https://tnu.aum.edu.vn/mod/quiz/view.php")).toBe(false);
  });

  it("finds only the next review page of the same quiz", () => {
    const current = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=0";
    expect(nextReviewPageUrl(doc('<a class="mod_quiz-next-nav" href="/mod/quiz/review.php?attempt=12&cmid=500414&page=1">Tiếp</a>'), current))
      .toBe("https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=1");
    expect(nextReviewPageUrl(doc('<a rel="next" href="/mod/quiz/review.php?attempt=99&cmid=7&page=1">Tiếp</a>'), current)).toBeUndefined();
  });

  it("selects the nearest later page from a Moodle pagination block", () => {
    const current = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=0";
    const document = doc('<nav class="pagination"><a href="/mod/quiz/review.php?attempt=12&cmid=500414&page=2">3</a><a href="/mod/quiz/review.php?attempt=12&cmid=500414&page=1">2</a></nav>');
    expect(nextReviewPageUrl(document, current)).toContain("page=1");
  });

  it("safely rejects invalid URLs and unrelated review attempts", () => {
    expect(quizModuleId("invalid")).toBeUndefined();
    expect(isSupportedQuizTarget("invalid")).toBe(false);
    expect(isAttemptForTarget("invalid", target)).toBe(false);
    expect(isReviewForTarget("invalid", target)).toBe(false);
    const current = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=500414&page=2";
    const document = doc('<nav class="pagination"><a href="/mod/quiz/review.php?attempt=13&cmid=500414&page=3">khác lượt</a><a href="/mod/quiz/review.php?attempt=12&cmid=500414&page=1">trước</a><a href="/mod/quiz/view.php?id=500414">khác trang</a></nav>');
    expect(nextReviewPageUrl(document, current)).toBeUndefined();
  });
});
