import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendLog, clearAllData, clearAnswerMemory, clearKnowledgeIndex, deleteApiKey, getAnswerMemory, getApiKey, getKnowledgeIndex, getRun, getState, markReviewCaptured, migrateSettings, saveAnswerMemory, saveApiKey, saveCourseIndex, saveKnowledgeIndex, saveQueue, saveRun, saveSettings, secureLocalStorage, updateRun, wasReviewCaptured } from "../src/storage";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { makeMemoryEntry } from "../src/answer-memory";
import type { KnowledgeIndex, QuestionSnapshot, QuizTarget, RunSession } from "../src/types";

function area() {
  let data: Record<string, unknown> = {};
  return {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])),
    set: async (value: Record<string, unknown>) => { data = { ...data, ...value }; },
    remove: async (key: string) => { delete data[key]; },
    clear: async () => { data = {}; },
    getBytesInUse: async () => JSON.stringify(data).length,
    setAccessLevel: vi.fn(async () => undefined)
  };
}
let local: ReturnType<typeof area>;
let session: ReturnType<typeof area>;
beforeEach(() => {
  local = area(); session = area();
  vi.stubGlobal("browser", { storage: { local, session } });
});
const target: QuizTarget = { id: "1", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=1", courseId: "c", courseName: "Môn", category: "", week: "1", name: "Bài", assessmentKind: "practice", source: "auto" };
const question: QuestionSnapshot = { id: "q", number: "1", type: "single", prompt: "Đúng?", options: [{ id: "option_0", label: "Có", selected: false }], images: [] };
const index: KnowledgeIndex = { courseId: "c", courseName: "Môn", indexedAt: "2026-01-01", materials: [], chunks: [{ id: "a", courseId: "c", materialId: "m", materialName: "Tài liệu", materialUrl: "url", week: "1", kind: "textbook", text: "Nội dung" }], failedMaterials: [] };

describe("persistent extension data", () => {
  it("migrates legacy settings without overwriting the key or model", async () => {
    await saveApiKey(" secret ");
    await saveSettings({ ...DEFAULT_SETTINGS, model: "legacy", provider: "chatgpt_manual" });
    expect(await getApiKey()).toBe("secret");
    expect((await getState()).settings).toMatchObject({ provider: "chatgpt_manual", model: "legacy" });
    expect(migrateSettings({ schemaVersion: 3, model: "old" })).toMatchObject({ schemaVersion: 12, model: "old", provider: "gemini_api", webTimeoutMs: 300_000, scormEnabled: false, practiceFullScoreEnabled: false, practiceAutoSubmit: false, practiceCollectCacheWhenFull: false, practiceMaxAttempts: 5, webAutoRetryCount: 2 });
    expect(migrateSettings({ schemaVersion: 4, provider: "claude_manual", model: "old", manualPrompt: "giữ prompt" })).toMatchObject({ schemaVersion: 12, provider: "claude_manual", model: "old", manualPrompt: "giữ prompt", selectionRevision: "legacy", webTimeoutMs: 300_000, scormPlaybackRate: 8 });
    expect(migrateSettings({ webTimeoutMs: 10_000 })).toMatchObject({ webTimeoutMs: 30_000 });
    expect(migrateSettings({ webTimeoutMs: 2_000_000 })).toMatchObject({ webTimeoutMs: 1_800_000 });
    expect(migrateSettings({ delayMs: -1 })).toMatchObject({ delayMs: 0 });
    expect(migrateSettings({ delayMs: 90_000 })).toMatchObject({ delayMs: 60_000 });
    expect(migrateSettings({ provider: "deepseek_web" })).toMatchObject({ provider: "deepseek_web" });
    await deleteApiKey();
    expect(await getApiKey()).toBe("");
  });
  it("saves and updates session independently from local data", async () => {
    const run = { id: "run", status: "preparing", target, updatedAt: "old" } as RunSession;
    await saveRun(run);
    expect((await updateRun({ status: "paused" }))?.status).toBe("paused");
    expect((await getRun())?.id).toBe("run");
    await saveRun(undefined);
    expect(await getRun()).toBeUndefined();
    expect(await updateRun({ status: "paused" })).toBeUndefined();
  });
  it("retains memory, index, queue, and review records until explicitly removed", async () => {
    const entry = makeMemoryEntry(target, question, ["Có"], "review");
    expect(await saveAnswerMemory([entry])).toBe(1);
    await saveKnowledgeIndex(index);
    await saveQueue([target]);
    await saveCourseIndex({ courses: [], scannedAt: "now", sourceUrl: "url" });
    await markReviewCaptured("review");
    await appendLog("info", "đã lưu");
    const state = await getState();
    expect(state.answerMemoryCount).toBe(1);
    expect(state.knowledgeIndexes[0]).toMatchObject({ courseId: "c", chunkCount: 1, indexedMaterialIds: ["m"] });
    expect(state.queue).toHaveLength(1);
    expect(state.logs[0]?.message).toBe("đã lưu");
    expect(await wasReviewCaptured("review")).toBe(true);
    expect((await getKnowledgeIndex("c"))?.chunks).toHaveLength(1);
    await clearKnowledgeIndex("c");
    await clearAnswerMemory();
    expect(await getKnowledgeIndex("c")).toBeUndefined();
    expect(await getAnswerMemory()).toHaveLength(0);
  });
  it("rejects an oversized index without replacing existing documents", async () => {
    await saveKnowledgeIndex(index);
    await expect(saveKnowledgeIndex({ ...index, chunks: [{ ...index.chunks[0]!, text: "x".repeat(8_000_000) }] })).rejects.toThrow();
    expect((await getKnowledgeIndex("c"))?.chunks[0]?.text).toBe("Nội dung");
  });
  it("clears both stores and reinstates restricted access", async () => {
    await saveApiKey("x");
    await markReviewCaptured("review");
    await secureLocalStorage();
    await clearAllData();
    expect(await getApiKey()).toBe("");
    expect(await wasReviewCaptured("review")).toBe(false);
    expect(local.setAccessLevel).toHaveBeenLastCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });
});
