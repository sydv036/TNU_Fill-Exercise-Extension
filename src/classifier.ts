import type { AppSettings, AssessmentKind } from "./types";

export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("vi").replace(/\s+/g, " ").trim();
}

export function classifyAssessment(name: string, settings: Pick<AppSettings, "practiceKeywords" | "gradedKeywords">): AssessmentKind {
  const normalized = normalizeText(name);
  const contains = (keyword: string) => normalized.includes(normalizeText(keyword));
  if (settings.gradedKeywords.some(contains)) return "graded";
  if (settings.practiceKeywords.some(contains)) return "practice";
  return "unknown";
}
