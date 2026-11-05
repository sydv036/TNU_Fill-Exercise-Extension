import { describe, expect, it } from "vitest";
import { findMemoryDecision, makeMemoryEntry, mergeAnswerMemory, selectedMemoryEvidence } from "../src/answer-memory";
import { extractReviewAnswerEntries, parseReviewTarget } from "../src/moodle";
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
  it("reconstructs a cache target from a standalone Moodle review page", () => {
    const document = doc(`<nav class="breadcrumb"><a href="/course/index.php?categoryid=7">Ngành chung</a><a href="/course/view.php?id=11086">Phát triển kỹ năng cá nhân - 260920</a><a href="/course/view.php?id=11086#section-7">Tuần 7: Bài 6</a><a href="/mod/quiz/view.php?id=500435">Bài luyện tập 6</a></nav>`);
    expect(parseReviewTarget(document, "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=1&cmid=500435")).toMatchObject({
      id: "11086:500435", courseId: "11086", name: "Bài luyện tập 6", week: "Tuần 7: Bài 6", assessmentKind: "practice"
    });
  });
  it("prefers the review breadcrumb course over an unrelated navigation drawer course", () => {
    const document = doc(`<aside><a href="/course/view.php?id=11086">Khóa gần đây nhưng không liên quan</a></aside><nav class="breadcrumb"><a href="/course/index.php?categoryid=7">Ngành chung</a><a href="/course/view.php?id=11085">Nhập môn Internet và E-Learning - 260920</a><a href="/course/view.php?id=11085#section-6">Tuần 6</a><a href="/mod/quiz/view.php?id=500399">Bài luyện tập 4</a></nav>`);
    expect(parseReviewTarget(document, "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=1&cmid=500399")).toMatchObject({
      id: "11085:500399", courseId: "11085", courseName: "Nhập môn Internet và E-Learning - 260920", week: "Tuần 6", name: "Bài luyện tập 4"
    });
  });
  it("does not reuse legacy cache for images or a different question type", () => {
    const question: QuestionSnapshot = { id: "q", number: "1", type: "single", prompt: "2 + 2?", images: [], options: [{ id: "option_0", label: "4", selected: false }] };
    const entry = makeMemoryEntry(target, question, ["4"], "review");
    expect(findMemoryDecision([entry], target, { ...question, type: "multiple" })).toBeUndefined();
    expect(findMemoryDecision([entry], target, { ...question, images: [{ mimeType: "image/png", data: "abc" }] })).toBeUndefined();
  });

  it("includes only matching selected cache sources in evidence", () => {
    const question: QuestionSnapshot = { id: "q", number: "1", type: "single", prompt: "2 + 2?", images: [], options: [{ id: "option_0", label: "4", selected: false }] };
    const entry = makeMemoryEntry(target, question, ["4"], "review");
    expect(selectedMemoryEvidence([entry], target, question, [entry.quizKey])).toHaveLength(1);
    expect(selectedMemoryEvidence([entry], target, question, [])).toHaveLength(0);
    expect(selectedMemoryEvidence([entry], target, { ...question, images: [{ mimeType: "image/png", data: "abc" }] }, [entry.quizKey])).toHaveLength(0);
  });
  it("extracts only the option Moodle marks as correct on a review page", () => {
    const document = doc(`<div class="que" id="q1"><div class="qtext">SMART dùng để làm gì?</div><div class="answer"><div class="r0 incorrect"><input id="a0" type="radio"><label for="a0">A. Lập lịch</label></div><div class="r1 correct"><input id="a1" type="radio" checked><label for="a1">B. Thiết lập mục tiêu</label></div></div></div>`);
    const entries = extractReviewAnswerEntries(document, target, "https://tnu.aum.edu.vn/mod/quiz/review.php?cmid=500414");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.correctOptionLabels).toEqual(["thiet lap muc tieu"]);
  });

  it("does not discard answers inside Moodle's question flag save form", () => {
    const document = doc(`<form class="questionflagsaveform"><div class="que multichoice deferredfeedback correct" id="question-1"><div class="info"><input class="questionflag" name="q1:flag" type="checkbox"></div><div class="qtext">Kỹ thuật Janusian dùng để làm gì?</div><div class="answer"><div class="r0"><input id="q1_answer0" name="q1_answer" type="radio"><div>A. Phương án sai</div></div><div class="r1 correct"><input id="q1_answer1" name="q1_answer" type="radio" checked><div>B. Xem xét khía cạnh đối diện</div></div></div><div class="rightanswer">Câu trả lời đúng là: Xem xét khía cạnh đối diện</div></div></form>`);
    const entries = extractReviewAnswerEntries(document, target, "https://tnu.aum.edu.vn/mod/quiz/review.php?cmid=500414");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.correctOptionLabels).toEqual(["xem xet khia canh đoi dien"]);
  });

  it("learns selected answers when the review state says Đúng", () => {
    const document = doc('<div class="que" id="q"><div class="state">Đúng</div><div class="qtext">Câu hỏi?</div><div class="answer"><label><input type="radio" checked>Đáp án đúng</label><label><input type="radio">Khác</label></div></div>');
    const entries = extractReviewAnswerEntries(document, target, "review");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.correctOptionLabels).toEqual(["đap an đung"]);
  });

  it("does not confuse a short option with a longer answer in review feedback", () => {
    const document = doc(`<div class="que" id="q1"><div class="qtext">Kết quả bằng bao nhiêu?</div><div class="answer"><div><input id="a0" type="radio"><label for="a0">A. 1</label></div><div><input id="a1" type="radio"><label for="a1">B. 10</label></div></div><div class="rightanswer">Đáp án đúng là: 10</div></div>`);
    const entries = extractReviewAnswerEntries(document, target, "https://tnu.aum.edu.vn/mod/quiz/review.php?cmid=500414");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.correctOptionLabels).toEqual(["10"]);
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

  it("reuses an exact remembered question elsewhere in the same course", () => {
    const learnedQuestion: QuestionSnapshot = {
      id: "practice-q1", number: "1", type: "single", prompt: "Mục tiêu SMART cần có đặc điểm nào?", images: [],
      options: [{ id: "option_0", label: "A. Đo lường được", selected: true }, { id: "option_1", label: "B. Càng chung chung càng tốt", selected: false }]
    };
    const entry = makeMemoryEntry(target, learnedQuestion, ["A. Đo lường được"], "review");
    const anotherQuiz = { ...target, id: "11086:999", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=999", name: "Bài kiểm tra" };
    const shuffled = {
      ...learnedQuestion,
      id: "graded-q7",
      options: [{ id: "option_0", label: "A. Càng chung chung càng tốt", selected: false }, { id: "option_1", label: "B. Đo lường được", selected: false }]
    };
    expect(findMemoryDecision([entry], anotherQuiz, shuffled, entry.quizKey)).toMatchObject({ selectedOptionIds: ["option_1"], source: "memory" });
  });

  it("does not search another saved section unless the user selects it", () => {
    const question: QuestionSnapshot = {
      id: "q1", number: "1", type: "single", prompt: "Mục tiêu SMART là gì?", images: [],
      options: [{ id: "option_0", label: "A. Mục tiêu đo lường được", selected: true }]
    };
    const entry = makeMemoryEntry(target, question, ["A. Mục tiêu đo lường được"], "review");
    const anotherQuiz = { ...target, url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=999" };
    expect(findMemoryDecision([entry], anotherQuiz, question)).toBeUndefined();
    expect(findMemoryDecision([entry], anotherQuiz, question, entry.quizKey)).toMatchObject({ source: "memory" });
  });

  it("does not reuse course memory across different courses", () => {
    const question: QuestionSnapshot = {
      id: "q1", number: "1", type: "single", prompt: "Khái niệm này là gì?", images: [],
      options: [{ id: "option_0", label: "A. Đáp án", selected: true }]
    };
    const entry = makeMemoryEntry(target, question, ["A. Đáp án"], "review");
    expect(findMemoryDecision([entry], { ...target, courseId: "different-course" }, question)).toBeUndefined();
  });

  it("combines multiple selected caches when they agree", () => {
    const question: QuestionSnapshot = {
      id: "q", number: "1", type: "single", prompt: "Kỹ năng lắng nghe là gì?", images: [],
      options: [{ id: "option_0", label: "A. Tiếp nhận chủ động", selected: false }, { id: "option_1", label: "B. Chỉ nghe âm thanh", selected: false }]
    };
    const first = makeMemoryEntry(target, question, ["A. Tiếp nhận chủ động"], "review-1");
    const otherTarget = { ...target, url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=999", name: "Bài luyện tập 2" };
    const second = makeMemoryEntry(otherTarget, question, ["A. Tiếp nhận chủ động"], "review-2");
    expect(findMemoryDecision([first, second], target, question, [first.quizKey, second.quizKey])).toMatchObject({ selectedOptionIds: ["option_0"], source: "memory" });
  });

  it("does not trust selected caches that conflict on the same question", () => {
    const question: QuestionSnapshot = {
      id: "q", number: "1", type: "single", prompt: "Một câu dùng lại", images: [],
      options: [{ id: "option_0", label: "A. Đáp án một", selected: false }, { id: "option_1", label: "B. Đáp án hai", selected: false }]
    };
    const first = makeMemoryEntry(target, question, ["A. Đáp án một"], "review-1");
    const otherTarget = { ...target, url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=999", name: "Bài luyện tập 2" };
    const second = makeMemoryEntry(otherTarget, question, ["B. Đáp án hai"], "review-2");
    expect(findMemoryDecision([first, second], target, question, [first.quizKey, second.quizKey])).toBeUndefined();
  });
});
