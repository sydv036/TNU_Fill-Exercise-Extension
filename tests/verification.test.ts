import { describe, expect, it } from "vitest";
import { confirmVerificationChoice, reconcileIndependentCheck } from "../src/verification";
import type { AnswerDecision } from "../src/types";

const primary: AnswerDecision = {
  selectedOptionIds: ["option_1"], confidence: 1, reason: "Đáp án cache", needsHumanReview: false, source: "memory"
};

describe("independent answer verification", () => {
  it("keeps the answer when Gemini independently agrees with enough confidence", () => {
    const result = reconcileIndependentCheck(primary, {
      selectedOptionIds: ["option_1"], confidence: 0.94, reason: "Đã đối chiếu từng lựa chọn", needsHumanReview: false, source: "gemini"
    }, 0.85);
    expect(result).toMatchObject({ selectedOptionIds: ["option_1"], confidence: 0.94, needsHumanReview: false });
    expect(result.verification?.status).toBe("agreed");
  });

  it("locks automatic apply when Gemini disagrees", () => {
    const result = reconcileIndependentCheck(primary, {
      selectedOptionIds: ["option_2"], confidence: 0.97, reason: "Kết luận khác", needsHumanReview: false, source: "gemini"
    }, 0.85);
    expect(result).toMatchObject({ selectedOptionIds: [], confidence: 0, needsHumanReview: true });
    expect(result.verification).toMatchObject({ status: "conflict", primaryOptionIds: ["option_1"], verifierOptionIds: ["option_2"] });
  });

  it("locks automatic apply when Gemini agrees but remains uncertain", () => {
    const result = reconcileIndependentCheck(primary, {
      selectedOptionIds: ["option_1"], confidence: 0.7, reason: "Chưa đủ căn cứ", needsHumanReview: true, source: "gemini"
    }, 0.85);
    expect(result.selectedOptionIds).toEqual([]);
    expect(result.verification?.status).toBe("uncertain");
  });

  it("restores the agreed answer after an explicit user confirmation", () => {
    const uncertain = reconcileIndependentCheck(primary, {
      selectedOptionIds: ["option_1"], confidence: 0.95, reason: "Cùng đáp án nhưng dưới ngưỡng", needsHumanReview: true, source: "gemini"
    }, 0.98);
    const confirmed = confirmVerificationChoice(uncertain, "primary");
    expect(confirmed).toMatchObject({ selectedOptionIds: ["option_1"], needsHumanReview: false });
    expect(confirmed.verification?.status).toBe("user_confirmed");
  });

  it("lets the user explicitly choose Gemini when the two checks conflict", () => {
    const conflict = reconcileIndependentCheck(primary, {
      selectedOptionIds: ["option_2"], confidence: 0.96, reason: "Kết quả khác", needsHumanReview: false, source: "gemini"
    }, 0.9);
    expect(confirmVerificationChoice(conflict, "verifier").selectedOptionIds).toEqual(["option_2"]);
  });
});
