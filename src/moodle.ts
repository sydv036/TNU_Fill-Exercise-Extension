import { classifyAssessment, normalizeText } from "./classifier";
import { canonicalOptionLabel, makeMemoryEntry } from "./answer-memory";
import type { AnswerMemoryEntry, AppSettings, CourseInfo, CourseWeek, QuestionSnapshot, QuizTarget } from "./types";

function absoluteUrl(href: string, baseUrl: string): string {
  try { return new URL(href, baseUrl).href; } catch { return href; }
}

function cleanActivityName(value: string): string {
  return value.replace(/\s*Trắc nghiệm\s*$/i, "").replace(/\s+/g, " ").trim();
}

export function parseDashboardCourses(document: Document, baseUrl: string): Array<Omit<CourseInfo, "weeks">> {
  const byId = new Map<string, Omit<CourseInfo, "weeks">>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="/course/view.php?id="]')) {
    const url = absoluteUrl(link.getAttribute("href") ?? "", baseUrl);
    const id = new URL(url).searchParams.get("id");
    const name = (link.getAttribute("title") || link.textContent || "").replace(/^Tên khoá học\s*/i, "").trim();
    if (!id || !name || byId.has(id)) continue;
    const context = link.closest(".course-info-container, .coursebox, li")?.textContent ?? "";
    const categoryMatch = context.match(/Danh mục khóa học\s*([^\n]+)/i);
    byId.set(id, { id, name, url, category: categoryMatch?.[1]?.trim() || "Khóa học của tôi" });
  }
  return [...byId.values()];
}

export function parseCourseActivities(
  document: Document,
  course: Omit<CourseInfo, "weeks">,
  settings: Pick<AppSettings, "practiceKeywords" | "gradedKeywords">
): CourseWeek[] {
  const weeks: CourseWeek[] = [];
  const sectionNodes = document.querySelectorAll<HTMLElement>('.section[id^="section-"], li[id^="section-"]');
  for (const [index, section] of [...sectionNodes].entries()) {
    const title = section.querySelector<HTMLElement>('h3.sectionname, [id^="sectionid-"][id$="-title"], .sectionname, h3')?.textContent?.trim()
      || `Phần ${index + 1}`;
    const activities: QuizTarget[] = [];
    for (const link of section.querySelectorAll<HTMLAnchorElement>('a[href*="/mod/quiz/view.php"]')) {
      const url = absoluteUrl(link.getAttribute("href") ?? "", course.url);
      const quizId = new URL(url).searchParams.get("id") ?? crypto.randomUUID();
      const name = cleanActivityName(link.textContent || link.getAttribute("title") || `Quiz ${quizId}`);
      activities.push({
        id: `${course.id}:${quizId}`,
        url,
        courseId: course.id,
        courseName: course.name,
        category: course.category,
        week: title,
        name,
        assessmentKind: classifyAssessment(`${title} ${name}`, settings),
        source: "auto"
      });
    }
    if (activities.length) weeks.push({ id: section.id || `section-${index}`, name: title, activities });
  }
  return weeks;
}

function labelForInput(input: HTMLInputElement): string {
  const escapedId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(input.id) : input.id.replace(/[:.]/g, "\\$&");
  const explicit = input.id ? input.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${escapedId}"]`) : null;
  const container = explicit ?? input.closest("label, .r0, .r1, .answer > div");
  return (container?.textContent || input.getAttribute("aria-label") || input.value || "").replace(/\s+/g, " ").trim();
}

export function extractQuestion(element: HTMLElement, index: number): QuestionSnapshot {
  const rawId = element.id || element.getAttribute("data-questionid") || `question-${index + 1}`;
  const qtext = element.querySelector<HTMLElement>(".qtext");
  const formulation = element.querySelector<HTMLElement>(".formulation");
  const prompt = (qtext?.innerText || qtext?.textContent
    || formulation?.innerText || formulation?.textContent
    || "").replace(/\s+/g, " ").trim();
  const inputs = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
    .filter((input) => !input.classList.contains("questionflag"));
  const options = inputs.map((input, optionIndex) => ({
    id: `option_${optionIndex}`,
    label: labelForInput(input),
    selected: input.checked
  }));
  let type: QuestionSnapshot["type"] = "unsupported";
  if (inputs.length && inputs.every((input) => input.type === "radio")) type = "single";
  if (inputs.length && inputs.every((input) => input.type === "checkbox")) type = "multiple";
  const normalizedLabels = options.map((option) => normalizeText(option.label));
  if (type === "single" && options.length === 2 && normalizedLabels.some((label) => /(^|\s)(dung|true)(\s|$)/.test(label)) && normalizedLabels.some((label) => /(^|\s)(sai|false)(\s|$)/.test(label))) {
    type = "truefalse";
  }
  return {
    id: rawId,
    number: element.querySelector<HTMLElement>(".qno, .info h3, .info")?.textContent?.replace(/\s+/g, " ").trim() || String(index + 1),
    type,
    prompt,
    options,
    images: []
  };
}

export function detectPageKind(url: string, document: Document): "dashboard" | "course" | "quiz-view" | "attempt" | "summary" | "review" | "other" {
  const path = new URL(url).pathname;
  if (path.includes("/mod/quiz/summary.php")) return "summary";
  if (path.includes("/mod/quiz/attempt.php") || document.querySelector("#responseform .que")) return "attempt";
  if (path.includes("/mod/quiz/review.php")) return "review";
  if (path.includes("/mod/quiz/view.php")) return "quiz-view";
  if (path.includes("/course/view.php")) return "course";
  if (path === "/my/" || path.includes("/my/index.php") || path.includes("/my/courses.php")) return "dashboard";
  return "other";
}

export function findQuestionElement(questionId: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(".que")].find((element) => element.id === questionId) ?? null;
}

export function applyDecisionToElement(element: HTMLElement, selectedOptionIds: string[]): boolean {
  const inputs = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
    .filter((input) => !input.classList.contains("questionflag"));
  if (!inputs.length) return false;
  inputs.forEach((input, index) => {
    const shouldSelect = selectedOptionIds.includes(`option_${index}`);
    if (input.checked !== shouldSelect) {
      input.checked = shouldSelect;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  return true;
}

export function markSuggestion(element: HTMLElement, selectedOptionIds: string[]): void {
  element.querySelectorAll("[data-tnu-gemini-suggestion]").forEach((node) => node.removeAttribute("data-tnu-gemini-suggestion"));
  const inputs = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
    .filter((input) => !input.classList.contains("questionflag"));
  inputs.forEach((input, index) => {
    if (!selectedOptionIds.includes(`option_${index}`)) return;
    const target = input.closest<HTMLElement>("label, .r0, .r1") ?? input.parentElement;
    target?.setAttribute("data-tnu-gemini-suggestion", "true");
  });
}

function correctLabelsFromReview(element: HTMLElement, question: QuestionSnapshot): string[] {
  const inputs = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
    .filter((input) => !input.classList.contains("questionflag"));
  const byMarkedRow = inputs.flatMap((input, index) => {
    const row = input.closest<HTMLElement>(".r0, .r1, .answer > div, label");
    const correctContainer = input.closest<HTMLElement>(".answer .correct");
    const marked = row?.classList.contains("correct")
      || Boolean(correctContainer && correctContainer.querySelectorAll('input[type="radio"], input[type="checkbox"]').length === 1);
    return marked && question.options[index] ? [question.options[index]!.label] : [];
  });
  if (byMarkedRow.length) return byMarkedRow;

  const rightAnswer = normalizeText(element.querySelector<HTMLElement>(".rightanswer")?.textContent ?? "");
  if (rightAnswer) {
    const byFeedback = question.options
      .filter((option) => rightAnswer.includes(canonicalOptionLabel(option.label)))
      .map((option) => option.label);
    if (byFeedback.length) return byFeedback;
  }

  const state = normalizeText(element.querySelector<HTMLElement>(".state")?.textContent ?? "");
  const fullyCorrect = element.classList.contains("correct") || /(^|\s)(dung|correct)(\s|$)/.test(state);
  if (fullyCorrect) return question.options.filter((option) => option.selected).map((option) => option.label);
  return [];
}

export function extractReviewAnswerEntries(document: Document, target: QuizTarget, sourceUrl: string): AnswerMemoryEntry[] {
  const entries: AnswerMemoryEntry[] = [];
  const elements = [...document.querySelectorAll<HTMLElement>(".que")];
  elements.forEach((element, index) => {
    const question = extractQuestion(element, index);
    if (question.type === "unsupported" || !question.prompt || !question.options.length) return;
    const labels = correctLabelsFromReview(element, question);
    if (!labels.length) return;
    entries.push(makeMemoryEntry(target, question, labels, sourceUrl));
  });
  return entries;
}
