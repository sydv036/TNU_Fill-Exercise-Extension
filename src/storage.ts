import { DEFAULT_SETTINGS } from "./defaults";
import type { AnswerMemoryEntry, AppSettings, AppState, CourseIndex, LogEntry, QuizTarget, RunSession } from "./types";

const KEYS = {
  settings: "settings",
  apiKey: "geminiApiKey",
  courseIndex: "courseIndex",
  queue: "queue",
  logs: "logs",
  run: "runSession",
  answerMemory: "answerMemory"
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
  return { ...DEFAULT_SETTINGS, ...(value as Partial<AppSettings>), schemaVersion: 2 };
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
  const local = await browser.storage.local.get([KEYS.courseIndex, KEYS.queue, KEYS.logs, KEYS.apiKey, KEYS.answerMemory]);
  const answerMemory = (local[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? [];
  return {
    settings: await getSettings(),
    apiKeyPresent: Boolean(local[KEYS.apiKey]),
    courseIndex: local[KEYS.courseIndex] as CourseIndex | undefined,
    queue: (local[KEYS.queue] as QuizTarget[] | undefined) ?? [],
    logs: (local[KEYS.logs] as LogEntry[] | undefined) ?? [],
    answerMemoryCount: answerMemory.length,
    storageBytes: await browser.storage.local.getBytesInUse(null),
    run: await getRun()
  };
}

export async function saveCourseIndex(courseIndex: CourseIndex): Promise<void> {
  await browser.storage.local.set({ [KEYS.courseIndex]: courseIndex });
}

export async function saveQueue(queue: QuizTarget[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.queue]: queue });
}

export async function getAnswerMemory(): Promise<AnswerMemoryEntry[]> {
  const value = await browser.storage.local.get(KEYS.answerMemory);
  return (value[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? [];
}

export async function saveAnswerMemory(entries: AnswerMemoryEntry[]): Promise<number> {
  const current = await getAnswerMemory();
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  entries.forEach((entry) => merged.set(entry.id, entry));
  const next = [...merged.values()].slice(-3000);
  await browser.storage.local.set({ [KEYS.answerMemory]: next });
  return next.length;
}

export async function clearAnswerMemory(): Promise<void> {
  await browser.storage.local.remove(KEYS.answerMemory);
}

export async function clearAllData(): Promise<void> {
  await Promise.all([browser.storage.local.clear(), browser.storage.session.clear()]);
  await secureLocalStorage();
}
