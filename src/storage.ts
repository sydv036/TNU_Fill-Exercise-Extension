import { DEFAULT_SETTINGS } from "./defaults";
import { mergeAnswerMemory, quizKey } from "./answer-memory";
import type { AnswerMemoryEntry, AnswerMemorySource, ApiProviderId, AppSettings, AppState, CourseIndex, KnowledgeIndex, KnowledgeIndexSummary, LogEntry, ModelCapability, QuizTarget, RunSession, ScormStatus, WebTabBinding } from "./types";
import { isValidModelPrice } from "./run-budget";

const KEYS = {
  settings: "settings",
  apiKey: "geminiApiKey",
  openaiApiKey: "openaiApiKey",
  anthropicApiKey: "anthropicApiKey",
  modelCapabilities: "modelCapabilities",
  courseIndex: "courseIndex",
  queue: "queue",
  logs: "logs",
  run: "runSession",
  answerMemory: "answerMemory",
  knowledgeIndexes: "knowledgeIndexes",
  reviewCaptures: "reviewCaptures"
} as const;
const SCORM_STATUS_KEY = "scormStatus";
const CREDENTIAL_LEASE_KEY = "credentialChangeLease";
const WEB_TAB_BINDING_KEY = "webTabBinding";

export async function secureLocalStorage(): Promise<void> {
  await browser.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function getSettings(): Promise<AppSettings> {
  const value = await browser.storage.local.get(KEYS.settings);
  return migrateSettings(value[KEYS.settings]);
}

export function migrateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const stored = value as Partial<AppSettings>;
  const providers: AppSettings["provider"][] = ["gemini_api", "openai_api", "anthropic_api", "chatgpt_manual", "claude_manual", "gemini_web_manual", "chatgpt_web", "claude_web", "gemini_web", "deepseek_web"];
  const cacheModes: AppSettings["cacheMode"][] = ["priority", "ai", "independent"];
  const apiProviders = ["gemini_api", "openai_api", "anthropic_api"] as const;
  const validOrder = Array.isArray(stored.fallbackOrder) && stored.fallbackOrder.length === 3 && new Set(stored.fallbackOrder).size === 3 && stored.fallbackOrder.every((id) => apiProviders.includes(id));
  const modelPrices = Array.isArray(stored.modelPrices) ? stored.modelPrices.filter(isValidModelPrice).slice(0, 30) : [];
  const allowedScormRates = [1, 1.5, 2, 3, 4, 6, 8];
  return { ...DEFAULT_SETTINGS, ...stored, modelPrices, unknownUsagePolicy: stored.unknownUsagePolicy === "warn_and_continue" ? "warn_and_continue" : "stop", maxCostUsd: typeof stored.maxCostUsd === "number" && Number.isFinite(stored.maxCostUsd) ? Math.max(0, Math.min(1000000, stored.maxCostUsd)) : 0, fallbackEnabled: stored.fallbackEnabled === true, fallbackOrder: validOrder ? stored.fallbackOrder! : [...DEFAULT_SETTINGS.fallbackOrder], fallbackMax: Number.isSafeInteger(stored.fallbackMax) ? Math.max(0, Math.min(2, stored.fallbackMax!)) : 2, maxRequests: Number.isSafeInteger(stored.maxRequests) ? Math.max(0, Math.min(100000, stored.maxRequests!)) : 0, maxTokens: Number.isSafeInteger(stored.maxTokens) ? Math.max(0, Math.min(1000000000, stored.maxTokens!)) : 0, selectionRevision: typeof stored.selectionRevision === "string" && stored.selectionRevision ? stored.selectionRevision : DEFAULT_SETTINGS.selectionRevision, provider: providers.includes(stored.provider as AppSettings["provider"]) ? stored.provider! : "gemini_api", cacheMode: cacheModes.includes(stored.cacheMode as AppSettings["cacheMode"]) ? stored.cacheMode! : "priority", documentLimit: Number.isInteger(stored.documentLimit) ? Math.max(1, Math.min(20, stored.documentLimit!)) : 5, manualRotationEvery: Number.isInteger(stored.manualRotationEvery) ? Math.max(0, Math.min(100, stored.manualRotationEvery!)) : 10, delayMs: Number.isFinite(stored.delayMs) ? Math.max(0, Math.min(60_000, stored.delayMs!)) : DEFAULT_SETTINGS.delayMs, timeoutMs: Number.isFinite(stored.timeoutMs) ? Math.max(5_000, Math.min(120_000, stored.timeoutMs!)) : DEFAULT_SETTINGS.timeoutMs, webTimeoutMs: Number.isFinite(stored.webTimeoutMs) ? Math.max(30_000, Math.min(1_800_000, stored.webTimeoutMs!)) : DEFAULT_SETTINGS.webTimeoutMs, scormEnabled: stored.scormEnabled === true, scormPlaybackRate: allowedScormRates.includes(stored.scormPlaybackRate ?? NaN) ? stored.scormPlaybackRate! : DEFAULT_SETTINGS.scormPlaybackRate, scormAutoNext: stored.scormAutoNext !== false, scormNextDelayMs: Number.isFinite(stored.scormNextDelayMs) ? Math.max(0, Math.min(10_000, stored.scormNextDelayMs!)) : DEFAULT_SETTINGS.scormNextDelayMs, scormPauseOnInteraction: stored.scormPauseOnInteraction !== false, schemaVersion: 10 };
}

export async function getScormStatus(): Promise<ScormStatus | undefined> {
  const value = await browser.storage.session.get(SCORM_STATUS_KEY);
  return value[SCORM_STATUS_KEY] as ScormStatus | undefined;
}

export async function saveScormStatus(status: ScormStatus): Promise<void> {
  await browser.storage.session.set({ [SCORM_STATUS_KEY]: status });
}

export async function getWebTabBinding(): Promise<WebTabBinding | undefined> {
  const value = await browser.storage.local.get(WEB_TAB_BINDING_KEY);
  const binding = value[WEB_TAB_BINDING_KEY] as WebTabBinding | undefined;
  if (!binding || !Number.isInteger(binding.tnuTabId) || !Number.isInteger(binding.aiTabId) || !Number.isInteger(binding.tnuWindowId) || !Number.isInteger(binding.aiWindowId)) return undefined;
  if (!["chatgpt_web", "claude_web", "gemini_web", "deepseek_web"].includes(binding.providerId)) return undefined;
  return binding;
}

export async function saveWebTabBinding(binding: WebTabBinding): Promise<void> {
  await browser.storage.local.set({ [WEB_TAB_BINDING_KEY]: binding });
}

export async function clearWebTabBinding(): Promise<void> {
  await browser.storage.local.remove(WEB_TAB_BINDING_KEY);
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
  await secureLocalStorage();
  await browser.storage.local.set({ [KEYS.apiKey]: apiKey.trim() });
  await clearProviderCapabilities("gemini_api");
}

export async function deleteApiKey(): Promise<void> {
  await browser.storage.local.remove(KEYS.apiKey);
  await clearProviderCapabilities("gemini_api");
}

export async function getProviderKey(provider: "openai_api" | "anthropic_api"): Promise<string> {
  const key = provider === "openai_api" ? KEYS.openaiApiKey : KEYS.anthropicApiKey;
  const value = await browser.storage.local.get(key);
  return typeof value[key] === "string" ? value[key] : "";
}

export async function saveProviderKey(provider: "openai_api" | "anthropic_api", apiKey: string): Promise<void> {
  await secureLocalStorage();
  const key = provider === "openai_api" ? KEYS.openaiApiKey : KEYS.anthropicApiKey;
  await browser.storage.local.set({ [key]: apiKey.trim() });
  await clearProviderCapabilities(provider);
}

export async function deleteProviderKey(provider: "openai_api" | "anthropic_api"): Promise<void> {
  await browser.storage.local.remove(provider === "openai_api" ? KEYS.openaiApiKey : KEYS.anthropicApiKey);
  await clearProviderCapabilities(provider);
}

export interface CredentialChangeLease { token: string; provider: ApiProviderId; expiresAt: number; }
export async function getCredentialChangeLease(): Promise<CredentialChangeLease | undefined> {
  const value = await browser.storage.session.get(CREDENTIAL_LEASE_KEY);
  const lease = value[CREDENTIAL_LEASE_KEY] as CredentialChangeLease | undefined;
  if (lease && lease.expiresAt <= Date.now()) { await browser.storage.session.remove(CREDENTIAL_LEASE_KEY); return undefined; }
  return lease;
}
export async function saveCredentialChangeLease(lease: CredentialChangeLease): Promise<void> {
  await browser.storage.session.set({ [CREDENTIAL_LEASE_KEY]: lease });
}
export async function clearCredentialChangeLease(): Promise<void> {
  await browser.storage.session.remove(CREDENTIAL_LEASE_KEY);
}

export async function getModelCapabilities(): Promise<ModelCapability[]> {
  const value = await browser.storage.local.get(KEYS.modelCapabilities);
  return Array.isArray(value[KEYS.modelCapabilities]) ? value[KEYS.modelCapabilities] as ModelCapability[] : [];
}

export async function clearProviderCapabilities(provider: ApiProviderId): Promise<void> {
  const existing = await getModelCapabilities();
  await browser.storage.local.set({ [KEYS.modelCapabilities]: existing.filter((item) => item.provider !== provider) });
}

export async function recordModelCapability(provider: ApiProviderId, model: string, image: boolean, passed: boolean, structured = false): Promise<void> {
  const items = await getModelCapabilities();
  const existing = items.find((item) => item.provider === provider && item.model === model) ?? { provider, model };
  const now = new Date().toISOString();
  const next = image
    ? { ...existing, imageVerifiedAt: passed ? now : undefined, imageFailedAt: passed ? undefined : now, ...(structured ? { structuredVerifiedAt: passed ? now : undefined, structuredFailedAt: passed ? undefined : now } : {}) }
    : { ...existing, textVerifiedAt: passed ? now : undefined, textFailedAt: passed ? undefined : now, ...(structured ? { structuredVerifiedAt: passed ? now : undefined, structuredFailedAt: passed ? undefined : now } : {}) };
  await browser.storage.local.set({ [KEYS.modelCapabilities]: [...items.filter((item) => item.provider !== provider || item.model !== model), next].slice(-100) });
}

export function supportsVerifiedTask(items: ModelCapability[], provider: ApiProviderId, model: string, images: boolean, now = Date.now(), structured = false): boolean {
  const item = items.find((entry) => entry.provider === provider && entry.model === model);
  const recent = (date?: string) => Boolean(date && Number.isFinite(Date.parse(date)) && now - Date.parse(date) >= 0 && now - Date.parse(date) <= 30 * 86400000);
  return Boolean(item && recent(item.textVerifiedAt) && (!images || recent(item.imageVerifiedAt)) && (!structured || recent(item.structuredVerifiedAt)));
}

export async function getRun(): Promise<RunSession | undefined> {
  const value = await browser.storage.session.get(KEYS.run);
  const run = value[KEYS.run] as RunSession | undefined;
  if (run?.usage) {
    run.usage.pending ??= [];
    run.usage.fallbackCount ??= 0;
  }
  return run;
}

async function writeRun(run?: RunSession): Promise<void> {
  if (run) await browser.storage.session.set({ [KEYS.run]: run });
  else await browser.storage.session.remove(KEYS.run);
}

let runMutation: Promise<unknown> = Promise.resolve();
export function saveRun(run?: RunSession): Promise<void> {
  const work = runMutation.then(() => writeRun(run));
  runMutation = work.catch(() => undefined);
  return work;
}

export function mutateRun(transform: (run: RunSession | undefined) => RunSession | undefined): Promise<RunSession | undefined> {
  const work = runMutation.then(async () => {
    const current = await getRun();
    const next = transform(current);
    if (next && next !== current) await writeRun({ ...next, updatedAt: new Date().toISOString() });
    return next;
  });
  runMutation = work.catch(() => undefined);
  return work;
}

export function updateRun(patch: Partial<RunSession>, guard?: { runId: string; executionEpoch: string; requireActive?: boolean }): Promise<RunSession | undefined> {
  return mutateRun((run) => {
    if (!run) return undefined;
    if (guard && (run.id !== guard.runId || run.executionEpoch !== guard.executionEpoch || (guard.requireActive && ["paused", "completed", "error"].includes(run.status)))) return undefined;
    return { ...run, ...patch };
  });
}

export async function appendLog(level: LogEntry["level"], message: string): Promise<void> {
  const value = await browser.storage.local.get(KEYS.logs);
  const logs = (Array.isArray(value[KEYS.logs]) ? value[KEYS.logs] : []) as LogEntry[];
  logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), level, message });
  await browser.storage.local.set({ [KEYS.logs]: logs.slice(0, 200) });
}

export async function getState(): Promise<AppState> {
  const local = await browser.storage.local.get([KEYS.courseIndex, KEYS.queue, KEYS.logs, KEYS.apiKey, KEYS.openaiApiKey, KEYS.anthropicApiKey, KEYS.modelCapabilities, KEYS.answerMemory, KEYS.knowledgeIndexes, WEB_TAB_BINDING_KEY]);
  const answerMemory = mergeAnswerMemory([], (local[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? []);
  const rawMemoryCount = ((local[KEYS.answerMemory] as AnswerMemoryEntry[] | undefined) ?? []).length;
  if (answerMemory.length !== rawMemoryCount) await browser.storage.local.set({ [KEYS.answerMemory]: answerMemory });
  const knowledgeIndexes = (local[KEYS.knowledgeIndexes] as Record<string, KnowledgeIndex> | undefined) ?? {};
  const summaries: KnowledgeIndexSummary[] = Object.values(knowledgeIndexes).map((index) => ({
    courseId: index.courseId, courseName: index.courseName, indexedAt: index.indexedAt,
    materialCount: index.materials.length, chunkCount: index.chunks.length, failedCount: index.failedMaterials.length,
    indexedMaterialIds: [...new Set(index.chunks.map((chunk) => chunk.materialId))]
  }));
  const courseIndex = local[KEYS.courseIndex] as CourseIndex | undefined;
  const activities = courseIndex?.courses.flatMap((course) => course.weeks.flatMap((week) => week.activities.map((activity) => ({ course, activity })))) ?? [];
  const memorySources = new Map<string, AnswerMemorySource>();
  for (const entry of answerMemory) {
    const matched = activities.find(({ activity }) => quizKey(activity) === entry.quizKey);
    const current = memorySources.get(entry.quizKey);
    memorySources.set(entry.quizKey, {
      quizKey: entry.quizKey,
      courseId: entry.courseId,
      courseName: entry.courseName || matched?.course.name || `Môn ${entry.courseId}`,
      week: entry.week || matched?.activity.week || "Phần đã lưu",
      quizName: entry.quizName || matched?.activity.name || entry.quizKey,
      answerCount: (current?.answerCount ?? 0) + 1,
      learnedAt: current && current.learnedAt > entry.learnedAt ? current.learnedAt : entry.learnedAt
    });
  }
  return {
    settings: await getSettings(),
    apiKeyPresent: Boolean(local[KEYS.apiKey]),
    providerKeys: { openai_api: Boolean(local[KEYS.openaiApiKey]), anthropic_api: Boolean(local[KEYS.anthropicApiKey]) },
    modelCapabilities: Array.isArray(local[KEYS.modelCapabilities]) ? local[KEYS.modelCapabilities] as ModelCapability[] : [],
    courseIndex,
    queue: (local[KEYS.queue] as QuizTarget[] | undefined) ?? [],
    logs: (local[KEYS.logs] as LogEntry[] | undefined) ?? [],
    answerMemoryCount: answerMemory.length,
    answerMemorySources: [...memorySources.values()].sort((left, right) => left.courseName.localeCompare(right.courseName, "vi") || left.week.localeCompare(right.week, "vi") || left.quizName.localeCompare(right.quizName, "vi")),
    knowledgeIndexes: summaries,
    storageBytes: await browser.storage.local.getBytesInUse(null),
    run: await getRun(),
    browserTabs: [],
    webTabBinding: local[WEB_TAB_BINDING_KEY] as WebTabBinding | undefined,
    scormStatus: await getScormStatus()
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
