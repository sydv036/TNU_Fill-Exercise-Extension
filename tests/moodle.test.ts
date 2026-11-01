import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { applyDecisionToElement, applyVerifiedDecisionToElement, isValidSelection, detectPageKind, extractQuestion, markSuggestion, parseCourseActivities, parseDashboardCourses } from "../src/moodle";

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Moodle parser", () => {
  it("recognizes review URLs even when the page contains a response form", () => {
    const document = doc('<form id="responseform"><div class="que"></div></form>');
    expect(detectPageKind("https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=1&cmid=2", document)).toBe("review");
  });

  it("deduplicates courses from the dashboard", () => {
    const document = doc(`
      <div class="course-info-container"><a href="/course/view.php?id=11086">Phát triển kỹ năng cá nhân - 260920</a><span>Danh mục khóa học Ngành chung</span></div>
      <a href="/course/view.php?id=11086">Phát triển kỹ năng cá nhân - 260920</a>
      <a href="/course/view.php?id=11085">Nhập môn Internet và E-Learning - 260920</a>
    `);
    const courses = parseDashboardCourses(document, "https://tnu.aum.edu.vn/my/");
    expect(courses).toHaveLength(2);
    expect(courses[0]).toMatchObject({ id: "11086", category: "Ngành chung" });
  });

  it("extracts quiz activities by week and treats checks as graded", () => {
    const document = doc(`
      <li class="section" id="section-1"><h3 class="sectionname">Tuần 1: Bài 1</h3><a href="/mod/quiz/view.php?id=500414">Bài luyện tập 1 Trắc nghiệm</a></li>
      <li class="section" id="section-4"><h3 class="sectionname">Tuần 4: Ôn tập và làm Bài kiểm tra 1</h3><a href="/mod/quiz/view.php?id=500423">Bài kiểm tra 1 Trắc nghiệm</a></li>
    `);
    const weeks = parseCourseActivities(document, { id: "11086", name: "Kỹ năng", url: "https://tnu.aum.edu.vn/course/view.php?id=11086", category: "Ngành chung" }, DEFAULT_SETTINGS);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.activities[0]).toMatchObject({ name: "Bài luyện tập 1", assessmentKind: "practice" });
    expect(weeks[1]!.activities[0]).toMatchObject({ assessmentKind: "graded" });
  });

  it("discovers slides, textbooks and electronic lectures by week", () => {
    const document = doc(`
      <li class="section" id="section-2"><h3 class="sectionname">Tuần 2: Kỹ năng giao tiếp</h3>
        <a href="/mod/resource/view.php?id=500415">Slide Bài 2</a>
        <a href="/mod/resource/view.php?id=500416">Giáo trình Bài 2</a>
        <a href="/mod/scorm/view.php?id=500417">Bài giảng điện tử Bài 2</a>
      </li>
    `);
    const weeks = parseCourseActivities(document, { id: "11086", name: "Kỹ năng", url: "https://tnu.aum.edu.vn/course/view.php?id=11086", category: "Ngành chung" }, DEFAULT_SETTINGS);
    expect(weeks[0]!.materials.map((item) => item.kind)).toEqual(["slide", "textbook", "lecture"]);
    expect(weeks[0]!.materials[1]).toMatchObject({ name: "Giáo trình Bài 2", week: "Tuần 2: Kỹ năng giao tiếp" });
  });

  it("extracts and applies a single-choice answer", () => {
    const document = doc(`<form id="responseform"><div class="que" id="question-1"><div class="info"><h3>Câu hỏi 1</h3></div><div class="qtext">SMART dùng để làm gì?</div><div class="answer"><div class="r0"><input id="a0" type="radio" name="q1"><label for="a0">A. Lập lịch</label></div><div class="r1"><input id="a1" type="radio" name="q1"><label for="a1">B. Thiết lập mục tiêu</label></div></div></div></form>`);
    const element = document.querySelector<HTMLElement>(".que")!;
    const question = extractQuestion(element, 0);
    expect(question).toMatchObject({ id: "question-1", type: "single", prompt: "SMART dùng để làm gì?" });
    expect(question.options.map((item) => item.label)).toEqual(["A. Lập lịch", "B. Thiết lập mục tiêu"]);
    expect(applyDecisionToElement(element, ["option_1"])).toBe(true);
    expect((document.querySelector("#a1") as HTMLInputElement).checked).toBe(true);
  });

  it("ignores Moodle's current question flag control when detecting answer type", () => {
    const document = doc(`<div class="que" id="question-flagged"><div class="info"><label><input type="checkbox" name="q1:flag" class="questionflagpostdata">Đặt cờ</label></div><div class="qtext">Chọn đáp án</div><div class="answer"><label><input type="radio" name="q1">A. Một</label><label><input type="radio" name="q1">B. Hai</label></div></div>`);
    const question = extractQuestion(document.querySelector<HTMLElement>(".que")!, 0);
    expect(question.type).toBe("single");
    expect(question.options.map((option) => option.label)).toEqual(["A. Một", "B. Hai"]);
  });

  it("recognizes summary before any submit action", () => {
    expect(detectPageKind("https://tnu.aum.edu.vn/mod/quiz/summary.php?attempt=1", doc('<button name="submitall">Nộp bài và kết thúc</button>'))).toBe("summary");
  });

  it("refuses to fill when options changed or the user selected an answer", () => {
    const document = doc('<div class="que" id="q"><div class="qtext">Câu hỏi</div><div class="answer"><label><input type="radio" name="q">Một</label><label><input type="radio" name="q">Hai</label></div></div>');
    const element = document.querySelector<HTMLElement>(".que")!;
    const snapshot = extractQuestion(element, 0);
    const labels = element.querySelectorAll("label");
    labels[0]!.append(" thay đổi");
    expect(applyVerifiedDecisionToElement(element, snapshot, ["option_0"])).toBe(false);
    expect(element.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
    labels[0]!.lastChild!.textContent = "";
    element.querySelectorAll<HTMLInputElement>("input")[1]!.checked = true;
    expect(applyVerifiedDecisionToElement(element, snapshot, ["option_0"])).toBe(false);
  });

  it("validates multi-choice selections before touching the page", () => {
    const document = doc('<div class="que" id="q"><div class="qtext">Chọn nhiều</div><div class="answer"><label><input type="checkbox">Một</label><label><input type="checkbox">Hai</label></div></div>');
    const element = document.querySelector<HTMLElement>(".que")!;
    const question = extractQuestion(element, 0);
    expect(question.type).toBe("multiple");
    expect(isValidSelection(question, [])).toBe(false);
    expect(isValidSelection(question, ["option_0", "option_0"])).toBe(false);
    expect(isValidSelection(question, ["option_99"])).toBe(false);
    expect(isValidSelection({ ...question, type: "unsupported" }, ["option_0"])).toBe(false);
    expect(applyVerifiedDecisionToElement(element, question, ["option_0", "option_1"])).toBe(true);
    expect(element.querySelectorAll("input:checked")).toHaveLength(2);
  });

  it("detects true/false and updates visual suggestions without selecting an answer", () => {
    const document = doc('<div class="que" id="q"><div class="qtext">Đúng?</div><div class="answer"><label><input type="radio" name="q">Đúng</label><label><input type="radio" name="q">Sai</label></div></div>');
    const element = document.querySelector<HTMLElement>(".que")!;
    const question = extractQuestion(element, 0);
    expect(question.type).toBe("truefalse");
    expect(isValidSelection(question, ["option_0", "option_1"])).toBe(false);
    markSuggestion(element, ["option_1"]);
    expect(element.querySelectorAll('[data-tnu-gemini-suggestion="true"]')).toHaveLength(1);
    expect(element.querySelectorAll("input:checked")).toHaveLength(0);
  });
});
