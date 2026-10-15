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
  const normalized = promptIdentity(prompt);
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function promptIdentity(prompt: string): string {
  return normalizeText(prompt)
    .replace(/đ/g, "d")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function promptTokens(prompt: string): Set<string> {
  return new Set(promptIdentity(prompt).split(" ").filter((token) => token.length > 1));
}

export function promptSimilarity(left: string, right: string): number {
  const a = promptIdentity(left);
  const b = promptIdentity(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 30 && (a.includes(b) || b.includes(a))) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const aTokens = promptTokens(a);
  const bTokens = promptTokens(b);
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

export function sameRememberedQuestion(left: Pick<AnswerMemoryEntry, "quizKey" | "prompt">, right: Pick<AnswerMemoryEntry, "quizKey" | "prompt">): boolean {
  return left.quizKey === right.quizKey && promptSimilarity(left.prompt, right.prompt) >= 0.9;
}

export function mergeAnswerMemory(current: AnswerMemoryEntry[], incoming: AnswerMemoryEntry[], limit = 3000): AnswerMemoryEntry[] {
  const next = [...current];
  for (const entry of incoming) {
    const duplicateIndex = next.findIndex((item) => item.id === entry.id || sameRememberedQuestion(item, entry));
    if (duplicateIndex >= 0) next[duplicateIndex] = { ...entry, id: next[duplicateIndex]!.id };
    else next.push(entry);
  }
  return next.slice(-limit);
}

export function canonicalOptionLabel(label: string): string {
  return normalizeText(label)
    .replace(/[\u200b-\u200d\ufeff✓✔]/g, "")
    .replace(/^(?:[a-z]|\d+)[\s.):_-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
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
    courseName: target.courseName,
    week: target.week,
    quizName: target.name,
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
  question: QuestionSnapshot,
  memorySourceQuizKeys: string[] | string | null | undefined = undefined
): AnswerDecision | undefined {
  if (memorySourceQuizKeys === null) return undefined;
  const keys = Array.isArray(memorySourceQuizKeys)
    ? memorySourceQuizKeys
    : [memorySourceQuizKeys ?? quizKey(target)];
  if (!keys.length) return undefined;
  const allowedKeys = new Set(keys);
  const rankedCandidates = entries
    .filter((item) => item.courseId === target.courseId && allowedKeys.has(item.quizKey) && item.correctOptionLabels.length > 0)
    .map((item) => {
      const exactPrompt = promptIdentity(item.prompt) === promptIdentity(question.prompt);
      const similarity = exactPrompt ? 1 : promptSimilarity(item.prompt, question.prompt);
      return { item, exactPrompt, similarity };
    })
    .filter(({ exactPrompt, similarity }) => exactPrompt || similarity >= 0.9)
    .sort((left, right) => Number(right.exactPrompt) - Number(left.exactPrompt) || right.similarity - left.similarity);

  // Một bản ghi cũ có thể không còn khớp bộ lựa chọn, nên thử các bản ghi
  // hợp lệ tiếp theo của cùng câu trước khi kết luận bộ nhớ không có đáp án.
  const matches: Array<{ entry: AnswerMemoryEntry; selectedOptionIds: string[] }> = [];
  for (const { item: entry } of rankedCandidates) {
    const rememberedLabels = entry.correctOptionLabels.map(canonicalOptionLabel);
    const selectedOptionIds = question.options
      .filter((option) => rememberedLabels.includes(canonicalOptionLabel(option.label)))
      .map((option) => option.id);
    if (!selectedOptionIds.length || selectedOptionIds.length !== rememberedLabels.length) continue;
    if ((question.type === "single" || question.type === "truefalse") && selectedOptionIds.length !== 1) continue;
    matches.push({ entry, selectedOptionIds });
  }
  if (!matches.length) return undefined;
  const signatures = new Set(matches.map(({ selectedOptionIds }) => [...selectedOptionIds].sort().join("|")));
  // Nhiều cache cho đáp án khác nhau thì không tự tin bất kỳ cache nào.
  if (signatures.size > 1) return undefined;
  const selectedOptionIds = matches[0]!.selectedOptionIds;
  const sources = [...new Set(matches.map(({ entry }) => [entry.courseName, entry.week, entry.quizName].filter(Boolean).join(" # ") || "phần đã chọn"))];
  const latestLearnedAt = matches.map(({ entry }) => entry.learnedAt).sort().at(-1)!;
  return {
    selectedOptionIds,
    confidence: 1,
    reason: `Đáp án đồng thuận từ ${sources.join("; ")}, được xác nhận đúng gần nhất ngày ${new Date(latestLearnedAt).toLocaleDateString("vi-VN")}.`,
    needsHumanReview: false,
    source: "memory"
  };
}
