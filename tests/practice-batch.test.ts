import { describe, expect, it } from "vitest";
import { groupPracticeTargets, practiceBatchIssue } from "../src/practice-batch";
import type { QuizTarget } from "../src/types";

function target(id: string, courseId = "course-1", courseName = "Môn 1", assessmentKind: QuizTarget["assessmentKind"] = "practice"): QuizTarget {
  return {
    id,
    courseId,
    courseName,
    category: "Ngành chung",
    week: `Tuần ${id}`,
    name: `Bài luyện tập ${id}`,
    url: `https://tnu.aum.edu.vn/mod/quiz/view.php?id=${id}`,
    assessmentKind,
    source: "auto"
  };
}

describe("practice batch selection", () => {
  it("accepts more than two practices from the same course", () => {
    expect(practiceBatchIssue([target("1"), target("2"), target("3"), target("4")])).toBeUndefined();
  });

  it("rejects a mixed-course batch with a clear reason", () => {
    expect(practiceBatchIssue([target("1"), target("2", "course-2", "Môn 2")])).toContain("cùng một môn");
  });

  it("groups every practice by course and excludes graded assessments", () => {
    const groups = groupPracticeTargets([
      target("1"),
      target("2"),
      target("3", "course-2", "Môn 2"),
      target("4", "course-2", "Môn 2"),
      target("5", "course-2", "Môn 2"),
      target("6", "course-2", "Môn 2", "graded")
    ]);
    expect(groups.map((group) => [group.courseName, group.targets.length])).toEqual([["Môn 1", 2], ["Môn 2", 3]]);
  });
});
