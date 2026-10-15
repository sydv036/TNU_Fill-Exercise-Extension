import type { AnswerDecision } from "./types";

function sameSelection(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function reconcileIndependentCheck(
  primary: AnswerDecision,
  verifier: AnswerDecision,
  confidenceThreshold: number
): AnswerDecision {
  const sameAnswer = sameSelection(primary.selectedOptionIds, verifier.selectedOptionIds);
  const verifierCertain = !verifier.needsHumanReview && verifier.confidence >= confidenceThreshold;
  const status = !sameAnswer ? "conflict" : verifierCertain ? "agreed" : "uncertain";
  const safeToApply = status === "agreed";
  return {
    ...primary,
    selectedOptionIds: safeToApply ? [...primary.selectedOptionIds] : [],
    confidence: safeToApply ? Math.min(primary.confidence, verifier.confidence) : 0,
    needsHumanReview: !safeToApply,
    reason: safeToApply
      ? `Kiểm tra kép đạt: đáp án ban đầu và Gemini suy luận độc lập cùng kết luận. ${verifier.reason}`.trim()
      : status === "conflict"
        ? "Kiểm tra kép phát hiện cache/gợi ý ban đầu và Gemini không đồng thuận. Tool đã khóa áp dụng tự động; hãy tự kiểm tra câu này."
        : "Gemini đồng thuận với đáp án ban đầu nhưng độ tin cậy chưa đạt ngưỡng. Tool đã khóa áp dụng tự động.",
    verification: {
      status,
      primarySource: primary.source === "memory" ? "memory" : "gemini",
      primaryOptionIds: [...primary.selectedOptionIds],
      primaryConfidence: primary.confidence,
      verifierOptionIds: [...verifier.selectedOptionIds],
      verifierConfidence: verifier.confidence,
      verifierReason: verifier.reason
    }
  };
}

export function confirmVerificationChoice(decision: AnswerDecision, choice: "primary" | "verifier"): AnswerDecision {
  const verification = decision.verification;
  if (!verification) throw new Error("Câu này chưa có kết quả kiểm tra kép để xác nhận.");
  const selectedOptionIds = choice === "primary" ? verification.primaryOptionIds : verification.verifierOptionIds;
  if (!selectedOptionIds.length) throw new Error("Kết quả được chọn không có phương án hợp lệ.");
  const selectedConfidence = choice === "primary" ? verification.primaryConfidence : verification.verifierConfidence;
  return {
    ...decision,
    selectedOptionIds: [...selectedOptionIds],
    confidence: Number.isFinite(selectedConfidence) ? selectedConfidence : verification.verifierConfidence,
    needsHumanReview: false,
    reason: `Bạn đã xác nhận thủ công ${choice === "primary" ? "gợi ý ban đầu" : "kết quả Gemini kiểm tra lại"}.`,
    verification: { ...verification, status: "user_confirmed" }
  };
}
