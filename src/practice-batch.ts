import type { QuizTarget } from "./types";

export interface PracticeBatchGroup {
  courseId: string;
  courseName: string;
  targets: QuizTarget[];
}

export function practiceBatchIssue(targets: QuizTarget[]): string | undefined {
  if (!targets.length) return "Chưa chọn bài luyện tập nào.";
  if (targets.some((target) => target.assessmentKind !== "practice")) return "Chuỗi chỉ nhận bài luyện tập.";
  const courseId = targets[0]!.courseId.trim();
  if (!courseId || targets.some((target) => target.courseId.trim() !== courseId)) return "Các bài trong chuỗi phải thuộc cùng một môn.";
  return undefined;
}

export function groupPracticeTargets(targets: QuizTarget[]): PracticeBatchGroup[] {
  const groups = new Map<string, PracticeBatchGroup>();
  for (const target of targets) {
    if (target.assessmentKind !== "practice") continue;
    const courseId = target.courseId.trim();
    if (!courseId) continue;
    const group = groups.get(courseId) ?? { courseId, courseName: target.courseName, targets: [] };
    group.targets.push(target);
    groups.set(courseId, group);
  }
  return [...groups.values()];
}
