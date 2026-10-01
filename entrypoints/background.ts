import { answerWithGemini, listGeminiModels } from "../src/gemini";
import { findMemoryDecision } from "../src/answer-memory";
import {
  appendLog, clearAllData, clearAnswerMemory, deleteApiKey, getAnswerMemory, getApiKey, getRun, getSettings, getState, saveAnswerMemory, saveApiKey,
  saveCourseIndex, saveQueue, saveRun, saveSettings, secureLocalStorage, updateRun
} from "../src/storage";
import type { CourseIndex, RuntimeMessage, RuntimeResponse, RunSession } from "../src/types";

const activeRequests = new Map<string, AbortController>();

async function activeTnuTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://tnu.aum.edu.vn/")) {
    throw new Error("Hãy mở một trang TNU trong tab hiện tại.");
  }
  return tab;
}

async function sendToActiveTab<T>(message: unknown): Promise<T> {
  const tab = await activeTnuTab();
  return browser.tabs.sendMessage(tab.id!, message) as Promise<T>;
}

async function notify(title: string, message: string, level: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  const settings = await getSettings();
  await appendLog(level, `${title}: ${message}`);
  if (!settings.notificationsEnabled) return;
  await browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("/icon-128.png"),
    title,
    message,
    priority: level === "error" ? 2 : 0
  });
}

async function handle(message: RuntimeMessage): Promise<RuntimeResponse> {
  switch (message.type) {
    case "GET_STATE":
      return { ok: true, data: await getState() };
    case "SAVE_SETTINGS":
      await saveSettings(message.settings);
      return { ok: true };
    case "SAVE_API_KEY":
      if (!message.apiKey.trim()) throw new Error("API key không được để trống.");
      await saveApiKey(message.apiKey);
      await appendLog("success", "Đã lưu Gemini API key trên máy.");
      return { ok: true };
    case "DELETE_API_KEY":
      activeRequests.forEach((controller) => controller.abort());
      activeRequests.clear();
      await deleteApiKey();
      if ((await getRun())?.status === "answering") await updateRun({ status: "paused", message: "Đã dừng vì API key vừa được xóa." });
      await appendLog("warning", "Đã xóa Gemini API key.");
      return { ok: true };
    case "LIST_MODELS": {
      const models = await listGeminiModels(await getApiKey());
      return { ok: true, data: models };
    }
    case "VALIDATE_API_KEY": {
      const models = await listGeminiModels(await getApiKey());
      return { ok: true, data: { modelCount: models.length } };
    }
    case "SCAN_COURSES": {
      await appendLog("info", "Bắt đầu quét khóa học TNU.");
      const result = await sendToActiveTab<RuntimeResponse<CourseIndex>>({ type: "SCAN_COURSES" });
      if (!result.ok || !result.data) throw new Error(result.error || "Không thể quét khóa học.");
      await saveCourseIndex(result.data);
      await appendLog("success", `Đã quét ${result.data.courses.length} khóa học.`);
      return { ok: true, data: result.data };
    }
    case "SAVE_QUEUE":
      await saveQueue(message.queue);
      return { ok: true };
    case "START_RUN": {
      const now = new Date().toISOString();
      const run: RunSession = {
        id: crypto.randomUUID(), target: message.target, mode: message.mode, status: "preparing",
        startedAt: now, updatedAt: now, page: 1, currentQuestion: 0, totalOnPage: 0,
        processedQuestionIds: [], startAnchorUsed: false, message: "Đang mở bài..."
      };
      await saveRun(run);
      await appendLog("info", `Bắt đầu ${message.target.name} (${message.target.assessmentKind}).`);
      const tab = await activeTnuTab();
      const stayOnCurrentAttempt = message.mode === "from_current" && tab.url?.includes("/mod/quiz/attempt.php");
      if (tab.url !== message.target.url && !stayOnCurrentAttempt) await browser.tabs.update(tab.id!, { url: message.target.url });
      else await browser.tabs.sendMessage(tab.id!, { type: "RESUME_RUN" }).catch(() => undefined);
      return { ok: true, data: run };
    }
    case "STOP_RUN":
      activeRequests.forEach((controller) => controller.abort());
      activeRequests.clear();
      await updateRun({ status: "paused", message: "Đã dừng theo yêu cầu." });
      await appendLog("warning", "Phiên chạy đã dừng.");
      await sendToActiveTab({ type: "STOP_RUN" }).catch(() => undefined);
      return { ok: true };
    case "RESUME_RUN":
      await updateRun({ status: "answering", error: undefined, message: "Đang tiếp tục..." });
      await sendToActiveTab({ type: "RESUME_RUN" });
      return { ok: true };
    case "RETRY_QUESTION":
      await updateRun({ status: "answering", error: undefined, pendingDecision: undefined, message: "Đang thử lại câu hiện tại..." });
      await sendToActiveTab({ type: "RETRY_QUESTION" });
      return { ok: true };
    case "SKIP_QUESTION":
      await sendToActiveTab({ type: "SKIP_QUESTION" });
      return { ok: true };
    case "APPLY_SUGGESTION":
      await sendToActiveTab({ type: "APPLY_SUGGESTION" });
      return { ok: true };
    case "ANSWER_QUESTION": {
      const run = await getRun();
      if (!run || run.status === "paused") throw new Error("Phiên chạy không còn hoạt động.");
      const remembered = findMemoryDecision(await getAnswerMemory(), run.target, message.question);
      if (remembered) {
        await appendLog("success", `Tìm thấy đáp án đã chấm đúng cho ${message.question.number}.`);
        return { ok: true, data: remembered };
      }
      const controller = new AbortController();
      const requestId = `${run.id}:${message.question.id}`;
      activeRequests.set(requestId, controller);
      try {
        const settings = await getSettings();
        const apiKey = await getApiKey();
        let decision = await answerWithGemini(apiKey, settings, message.question, controller.signal);
        if (settings.uncertainMode === "reason" && (decision.needsHumanReview || decision.confidence < settings.confidenceThreshold)) {
          await updateRun({ message: `${message.question.number}: Gemini đang tự suy luận lại...` });
          decision = await answerWithGemini(apiKey, settings, message.question, controller.signal, fetch, true);
        }
        return { ok: true, data: decision };
      } finally {
        activeRequests.delete(requestId);
      }
    }
    case "SAVE_REVIEW_ANSWERS": {
      if (!message.entries.length) return { ok: true, data: { saved: 0, total: (await getAnswerMemory()).length } };
      const total = await saveAnswerMemory(message.entries);
      await appendLog("success", `Đã học ${message.entries.length} đáp án đúng từ trang xem lại.`);
      return { ok: true, data: { saved: message.entries.length, total } };
    }
    case "CLEAR_ANSWER_MEMORY":
      await clearAnswerMemory();
      await appendLog("warning", "Đã xóa toàn bộ bộ nhớ đáp án đúng.");
      return { ok: true };
    case "CLEAR_ALL_DATA":
      activeRequests.forEach((controller) => controller.abort());
      activeRequests.clear();
      await sendToActiveTab({ type: "STOP_RUN" }).catch(() => undefined);
      await clearAllData();
      return { ok: true };
    case "UPDATE_RUN":
      return { ok: true, data: await updateRun(message.patch) };
    case "NOTIFY":
      await notify(message.title, message.message, message.level);
      return { ok: true };
    case "CONTENT_READY":
      return { ok: true };
    default:
      return { ok: false, error: "Thông điệp không được hỗ trợ." };
  }
}

export default defineBackground(() => {
  void secureLocalStorage();
  browser.runtime.onInstalled.addListener(() => {
    void secureLocalStorage();
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
  browser.runtime.onStartup.addListener(() => void secureLocalStorage());
  browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    handle(message)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RuntimeResponse));
    return true;
  });
});
