import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { applyDecisionToElement, detectPageKind, extractQuestion, parseCourseActivities, parseDashboardCourses } from "../src/moodle";

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Moodle parser", () => {
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

  it("extracts and applies a single-choice answer", () => {
    const document = doc(`<form id="responseform"><div class="que" id="question-1"><div class="info"><h3>Câu hỏi 1</h3></div><div class="qtext">SMART dùng để làm gì?</div><div class="answer"><div class="r0"><input id="a0" type="radio" name="q1"><label for="a0">A. Lập lịch</label></div><div class="r1"><input id="a1" type="radio" name="q1"><label for="a1">B. Thiết lập mục tiêu</label></div></div></div></form>`);
    const element = document.querySelector<HTMLElement>(".que")!;
    const question = extractQuestion(element, 0);
    expect(question).toMatchObject({ id: "question-1", type: "single", prompt: "SMART dùng để làm gì?" });
    expect(question.options.map((item) => item.label)).toEqual(["A. Lập lịch", "B. Thiết lập mục tiêu"]);
    expect(applyDecisionToElement(element, ["option_1"])).toBe(true);
    expect((document.querySelector("#a1") as HTMLInputElement).checked).toBe(true);
  });

  it("recognizes summary before any submit action", () => {
    expect(detectPageKind("https://tnu.aum.edu.vn/mod/quiz/summary.php?attempt=1", doc('<button name="submitall">Nộp bài và kết thúc</button>'))).toBe("summary");
  });
});
