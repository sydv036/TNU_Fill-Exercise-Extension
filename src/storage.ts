import { DEFAULT_SETTINGS } from "./defaults";
import { mergeAnswerMemory } from "./answer-memory";
import type { AnswerMemoryEntry, AppSettings, AppState, CourseIndex, KnowledgeIndex, KnowledgeIndexSummary, LogEntry, QuizTarget, RunSession } from "./types";

const KEYS = {
  settings: "settings",
  apiKey: "geminiApiKey",
  courseIndex: "courseIndex",
  queue: "queue",
  logs: "logs",
  run: "runSession",
  answerMemory: "answerMemory",
  knowledgeIndexes: "knowledgeIndexes",
  reviewCaptures: "reviewCaptures"
} as const;

export async function secureLocalStorage(): Promise<void> {
  await browser.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function getSettings(): Promise<AppSettings> {
  const value = await browser.storage.local.get(KEYS.settings);
  return migrateSettings(value[KEYS.settings]);
}

export function migrateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(value as Partial<AppSettings>), schemaVersion: 3 };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await browser.storage.local.set({ [KEYS.settings]: migrateSettings(settings) });
}

export async function getApiKey(): Promise<string> {
  const value = await browser.storage.local.get(KEYS.apiKey);
  const apiKey = value[KEYS.apiKey];
  return typeof apiKey === "string" ? apiKey : "";
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await browser.storage.local.set({ [KEYS.apiKey]: apiKey.trim() });
}

export async function deleteApiKey(): Promise<void> {
  await browser.storage.local.remove(KEYS.apiKey);
}

export async function getRun(): Promise<RunSession | undefined> {
  const value = await browser.storage.session.get(KEYS.run);
  return value[KEYS.run] as RunSession | undefined;
}

export async function saveRun(run?: RunSession): Promise<void> {
  if (run) await browser.storage.session.set({ [KEYS.run]: run });
  else await browser.storage.session.remove(KEYS.run);
}

export async function updateRun(patch: Partial<RunSession>): Promise<RunSession | undefined> {
  const run = await getRun();
  if (!run) return undefined;
  const next = { ...run, ...patch, updatedAt: new Date().toISOString() };
  await saveRun(next);
  return next;
}

export async function appendLog(level: LogEntry["level"], message: string): Promise<void> {
  const value = await browser.storage.local.get(KEYS.logs);
  const logs = (Array.isArray(value[KEYS.logs]) ? value[KEYS.logs] : []) as LogEntry[];
  logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), level, message });
  await browser.storage.local.set({ [KEYS.logs]: logs.slice(0, 200) });
}

export async function getState(): Promise<AppState> {
  const local = await browser.storage.local.get([KEYS.courseIndex, KEYS.queue, KEYS.logs, KEYS.apiKey, KEYS.answerMemory, KEYS.knowledgeIndexes]);
  const answerMemory = mergeAnswerMemory([], (local[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? []);
  const rawMemoryCount = ((local[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? []).length;
  if (answerMemory.length !== rawMemoryCount) await browser.storage.local.set({ [KEYS.answerMemory]: answerMemory });
  const knowledgeIndexes = (local[KEYS.knowledgeIndexes] as Record<string, KnowledgeIndex> | undefined) ?? {};
  const summaries: KnowledgeIndexSummary[] = Object.values(knowledgeIndexes).map((index) => ({
    courseId: index.courseId, courseName: index.courseName, indexedAt: index.indexedAt,
    materialCount: index.materials.length, chunkCount: index.chunks.length, failedCount: index.failedMaterials.length
  }));
  return {
    settings: await getSettings(),
    apiKeyPresent: Boolean(local[KEYS.apiKey]),
    courseIndex: local[KEYS.courseIndex] as CourseIndex | undefined,
    queue: (local[KEYS.queue] as QuizTarget[] | undefined) ?? [],
    logs: (local[KEYS.logs] as LogEntry[] | undefined) ?? [],
    answerMemoryCount: answerMemory.length,
    knowledgeIndexes: summaries,
    storageBytes: await browser.storage.local.getBytesInUse(null),
    run: await getRun()
  };
}

export async function getKnowledgeIndex(courseId: string): Promise<KnowledgeIndex | undefined> {
  const value = await browser.storage.local.get(KEYS.knowledgeIndexes);
  return (value[KEYS.knowledgeIndexes] as Record<string, KnowledgeIndex> | undefined)?.[courseId];
}

export async function saveKnowledgeIndex(index: KnowledgeIndex): Promise<void> {
  const value = await browser.storage.local.get(KEYS.knowledgeIndexes);
  const indexes = (value[KEYS.knowledgeIndexes] as Record<string, KnowledgeIndex> | undefined) ?? {};
  const next = { ...indexes, [index.courseId]: index };
  const estimatedBytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
  if (estimatedBytes > 8_000_000) throw new Error("Chỉ mục tài liệu vượt 8 MB. Hãy xóa chỉ mục môn cũ hoặc chọn ít tài liệu hơn.");
  await browser.storage.local.set({ [KEYS.knowledgeIndexes]: next });
}

export async function clearKnowledgeIndex(courseId: string): Promise<void> {
  const value = await browser.storage.local.get(KEYS.knowledgeIndexes);
  const indexes = { ...((value[KEYS.knowledgeIndexes] as Record<string, KnowledgeIndex> | undefined) ?? {}) };
  delete indexes[courseId];
  await browser.storage.local.set({ [KEYS.knowledgeIndexes]: indexes });
}

export async function wasReviewCaptured(url: string): Promise<boolean> {
  const value = await browser.storage.session.get(KEYS.reviewCaptures);
  return Boolean((value[KEYS.reviewCaptures] as Record<string, boolean> | undefined)?.[url]);
}

export async function markReviewCaptured(url: string): Promise<void> {
  const value = await browser.storage.session.get(KEYS.reviewCaptures);
  const captures = (value[KEYS.reviewCaptures] as Record<string, boolean> | undefined) ?? {};
  await browser.storage.session.set({ [KEYS.reviewCaptures]: { ...captures, [url]: true } });
}

export async function saveCourseIndex(courseIndex: CourseIndex): Promise<void> {
  await browser.storage.local.set({ [KEYS.courseIndex]: courseIndex });
}

export async function saveQueue(queue: QuizTarget[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.queue]: queue });
}

export async function getAnswerMemory(): Promise<AnswerMemoryEntry[]> {
  const value = await browser.storage.local.get(KEYS.answerMemory);
  const stored = (value[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? [];
  const normalized = mergeAnswerMemory([], stored);
  if (normalized.length !== stored.length) await browser.storage.local.set({ [KEYS.answerMemory]: normalized });
  return normalized;
}

export async function saveAnswerMemory(entries: AnswerMemoryEntry[]): Promise<number> {
  const current = await getAnswerMemory();
  const limited = mergeAnswerMemory(current, entries);
  await browser.storage.local.set({ [KEYS.answerMemory]: limited });
  return limited.length;
}

export async function clearAnswerMemory(): Promise<void> {
  await browser.storage.local.remove(KEYS.answerMemory);
}

export async function clearAllData(): Promise<void> {
  await Promise.all([browser.storage.local.clear(), browser.storage.session.clear()]);
  await secureLocalStorage();
}
