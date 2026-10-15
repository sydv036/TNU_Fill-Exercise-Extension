import { describe, expect, it } from "vitest";
import { findMemoryDecision, makeMemoryEntry, mergeAnswerMemory } from "../src/answer-memory";
import { extractReviewAnswerEntries } from "../src/moodle";
import type { QuestionSnapshot, QuizTarget } from "../src/types";

const target: QuizTarget = {
  id: "11086:500414", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=500414", courseId: "11086",
  courseName: "Kỹ năng", category: "Ngành chung", week: "Tuần 1", name: "Bài luyện tập 1",
  assessmentKind: "practice", source: "auto"
};

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("answer memory", () => {
  it("extracts only the option Moodle marks as correct on a review page", () => {
    const document = doc(`<div class="que" id="q1"><div class="qtext">SMART dùng để làm gì?</div><div class="answer"><div class="r0 incorrect"><input id="a0" type="radio"><label for="a0">A. Lập lịch</label></div><div class="r1 correct"><input id="a1" type="radio" checked><label for="a1">B. Thiết lập mục tiêu</label></div></div></div>`);
    const entries = extractReviewAnswerEntries(document, target, "https://tnu.aum.edu.vn/mod/quiz/review.php?cmid=500414");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.correctOptionLabels).toEqual(["thiet lap muc tieu"]);
  });

  it("matches a remembered answer even when Moodle shuffles option order and letters", () => {
    const oldQuestion: QuestionSnapshot = {
      id: "q1", number: "Câu 1", type: "single", prompt: "SMART dùng để làm gì?", images: [],
      options: [{ id: "option_0", label: "A. Lập lịch", selected: false }, { id: "option_1", label: "B. Thiết lập mục tiêu", selected: true }]
    };
    const entry = makeMemoryEntry(target, oldQuestion, ["B. Thiết lập mục tiêu"], "review");
    const shuffled: QuestionSnapshot = {
      ...oldQuestion,
      options: [{ id: "option_0", label: "A. Thiết lập mục tiêu", selected: false }, { id: "option_1", label: "B. Lập lịch", selected: false }]
    };
    expect(findMemoryDecision([entry], target, shuffled)).toMatchObject({ selectedOptionIds: ["option_0"], confidence: 1, source: "memory" });
  });

  it("does not reuse an incomplete answer when current options do not match", () => {
    const question: QuestionSnapshot = { id: "q", number: "1", type: "single", prompt: "Câu hỏi", images: [], options: [{ id: "option_0", label: "Khác", selected: false }] };
    const entry = makeMemoryEntry(target, question, ["Đáp án đúng"], "review");
    expect(findMemoryDecision([entry], target, question)).toBeUndefined();
  });

  it("recognizes the same question when Moodle changes punctuation and hidden spacing", () => {
    const reviewed: QuestionSnapshot = {
      id: "review-1", number: "Câu 1", type: "single",
      prompt: "Vì sao con người cần nhận thức được điểm mạnh và điểm yếu của bản thân?",
      images: [], options: [{ id: "option_0", label: "A. Để phát triển và khắc phục điểm yếu", selected: true }]
    };
    const entry = makeMemoryEntry(target, reviewed, ["A. Để phát triển và khắc phục điểm yếu"], "review");
    const nextAttempt: QuestionSnapshot = {
      ...reviewed, id: "attempt-2",
      prompt: "Vì sao con người cần nhận thức được điểm mạnh, điểm yếu của bản thân ?\u200b",
      options: [{ id: "option_0", label: "B. Để phát triển và khắc phục điểm yếu ✓", selected: false }]
    };
    expect(findMemoryDecision([entry], target, nextAttempt)).toMatchObject({ selectedOptionIds: ["option_0"], source: "memory" });
  });

  it("merges formatting variants instead of adding another remembered question", () => {
    const question: QuestionSnapshot = {
      id: "q1", number: "1", type: "single", prompt: "Mô hình cửa sổ Johari là gì?", images: [],
      options: [{ id: "option_0", label: "A. Một mô hình tự nhận thức", selected: true }]
    };
    const first = makeMemoryEntry(target, question, ["A. Một mô hình tự nhận thức"], "review-1");
    const variant = makeMemoryEntry(target, { ...question, prompt: "Mô hình cửa sổ Johari là gì ?\u200b" }, ["B. Một mô hình tự nhận thức"], "review-2");
    const merged = mergeAnswerMemory([first], [variant]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: first.id, sourceUrl: "review-2" });
  });
});
