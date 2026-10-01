import { normalizeText } from "./classifier";
import type { AnswerDecision, AnswerMemoryEntry, QuestionSnapshot, QuizTarget } from "./types";

export function quizKey(target: Pick<QuizTarget, "url" | "courseId" | "name">): string {
  try {
    const url = new URL(target.url);
    const cmid = url.searchParams.get("id") || url.searchParams.get("cmid");
    if (cmid) return `${target.courseId}:cmid:${cmid}`;
  } catch { /* URL nhập thủ công có thể chưa hợp lệ. */ }
  return `${target.courseId}:name:${normalizeText(target.name)}`;
}

export function questionFingerprint(prompt: string): string {
  const normalized = normalizeText(prompt);
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function canonicalOptionLabel(label: string): string {
  return normalizeText(label).replace(/^(?:[a-z]|\d+)[\s.):_-]+/, "").trim();
}

export function makeMemoryEntry(
  target: QuizTarget,
  question: QuestionSnapshot,
  correctOptionLabels: string[],
  sourceUrl: string
): AnswerMemoryEntry {
  const key = quizKey(target);
  const fingerprint = questionFingerprint(question.prompt);
  return {
    id: `${key}:${fingerprint}`,
    quizKey: key,
    courseId: target.courseId,
    questionFingerprint: fingerprint,
    prompt: question.prompt,
    questionType: question.type,
    correctOptionLabels: [...new Set(correctOptionLabels.map(canonicalOptionLabel).filter(Boolean))],
    learnedAt: new Date().toISOString(),
    sourceUrl
  };
}

export function findMemoryDecision(
  entries: AnswerMemoryEntry[],
  target: QuizTarget,
  question: QuestionSnapshot
): AnswerDecision | undefined {
  const key = quizKey(target);
  const fingerprint = questionFingerprint(question.prompt);
  const entry = entries.find((item) => item.quizKey === key && item.questionFingerprint === fingerprint);
  if (!entry?.correctOptionLabels.length) return undefined;
  const selectedOptionIds = question.options
    .filter((option) => entry.correctOptionLabels.includes(canonicalOptionLabel(option.label)))
    .map((option) => option.id);
  if (!selectedOptionIds.length || selectedOptionIds.length !== entry.correctOptionLabels.length) return undefined;
  if ((question.type === "single" || question.type === "truefalse") && selectedOptionIds.length !== 1) return undefined;
  return {
    selectedOptionIds,
    confidence: 1,
    reason: `Đáp án đã được xác nhận đúng từ lần chấm ngày ${new Date(entry.learnedAt).toLocaleDateString("vi-VN")}.`,
    needsHumanReview: false,
    source: "memory"
  };
}
