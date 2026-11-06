import { answerKnowledgeWithGemini, answerWithGemini, listGeminiModels } from "../src/gemini";
import { DEFAULT_SETTINGS } from "../src/defaults";
import { answerWithExternalApi, listExternalModels } from "../src/auto-provider";
import type { ExternalApiProvider } from "../src/auto-provider";
import { buildManualPrompt, parseManualResponse } from "../src/manual-ai";
import { beginCheckpoint, clearCheckpoint, clearCompletedCheckpoint, clearRejectedCheckpoint, getCheckpoint, retargetRejectedCheckpoint, updateCheckpoint } from "../src/request-checkpoint";
import { ApiError } from "../src/api-policy";
import type { ProviderUsage, RequestHooks } from "../src/api-policy";
import { estimateRequestTokens, incrementFallbackCount, markUnknownUsage, releaseUnsentReservation, reserveUsage, resolveUnknownReservation, settleUsage, updateReservationStatus } from "../src/run-budget";
import { capabilityQuestion } from "../src/capability-probe";
import { getProvider } from "../src/providers";
import { canChangeSelection, isCurrentExecution, resumeWithSelection, selectedModel, selectedProviderModel } from "../src/ai-selection";
import { recordManualReply, shouldStartManualChat } from "../src/conversation";
import { findMemoryDecision, quizKey, selectedMemoryEvidence } from "../src/answer-memory";
import { citationFromChunk, searchKnowledge, searchSelectedKnowledge } from "../src/knowledge";
import { isAttemptForTarget, isReviewForTarget, isSupportedQuizTarget } from "../src/quiz-navigation";
import { practiceBatchReviewStep } from "../src/run-policy";
import { practiceBatchIssue } from "../src/practice-batch";
import { practiceReviewTransition, resetRunForPracticeAttempt } from "../src/practice-automation";
import { confirmVerificationChoice, reconcileIndependentCheck } from "../src/verification";
import { inferUniqueWebTabBinding, isWebProvider, shouldInvalidateBindingForAiUrl, summarizeBrowserTabs, validateStoredBinding, validateWebTabBinding, webAutomationPolicy } from "../src/web-tabs";
import { buildWebRequestPrompt, ConfirmedWebCancellationError, createVerifiedConversation, executeWebRequest, parseWebAnswer, UnknownWebOutcomeError } from "../src/web-adapter";
import { FixtureTabWebAdapter } from "../src/web-fixture-adapter";
import { LiveTabWebAdapter } from "../src/live-web-adapter";
import {
  appendLog, clearAllData, clearAnswerMemory, clearCredentialChangeLease, clearKnowledgeIndex, clearProviderCapabilities, clearWebTabBinding, getAnswerMemory, getApiKey, getCredentialChangeLease, getKnowledgeIndex, getRun, getSettings, getState, getWebTabBinding,
  markReviewCaptured, mutateRun, saveAnswerMemory, saveCourseIndex, saveCredentialChangeLease, saveKnowledgeIndex, saveQueue, saveRun, saveSettings, saveWebTabBinding, secureLocalStorage, updateRun, wasReviewCaptured, getProviderKey, getModelCapabilities, recordModelCapability, supportsVerifiedTask, saveScormStatus
} from "../src/storage";
import type { ApiProviderId, AppSettings, CourseIndex, KnowledgeChunk, KnowledgeExtractionResult, KnowledgeIndex, KnowledgeSearchResponse, QuestionSnapshot, RuntimeMessage, RuntimeResponse, RunSession } from "../src/types";

const activeRequests = new Map<string, AbortController>();
const manualSubmissions = new Set<string>();
let controlQueue: Promise<unknown> = Promise.resolve();
let storageAccessReady: Promise<void> = Promise.resolve();

function isExtensionPage(sender: Browser.runtime.MessageSender): boolean {
  const extensionRoot = browser.runtime.getURL("/");
  return sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(extensionRoot);
}

const CONTENT_MESSAGE_TYPES = new Set<RuntimeMessage["type"]>(["GET_STATE", "ANSWER_QUESTION", "UPDATE_RUN", "SAVE_REVIEW_ANSWERS", "NOTIFY", "CONTENT_READY", "SCORM_STATUS_UPDATE"]);
const EXTENSION_ONLY_TYPES = new Set<RuntimeMessage["type"]>([
  "SAVE_SETTINGS", "SWITCH_PROVIDER", "SELECT_GEMINI_MODEL", "BEGIN_CREDENTIAL_CHANGE", "COMPLETE_CREDENTIAL_CHANGE", "CANCEL_CREDENTIAL_CHANGE",
  "LIST_PROVIDER_MODELS", "SELECT_PROVIDER_MODEL", "TEST_API_CAPABILITY", "LIST_MODELS", "VALIDATE_API_KEY", "SCAN_COURSES", "SAVE_QUEUE",
  "START_RUN", "STOP_RUN", "RESUME_RUN", "RETRY_QUESTION", "SKIP_QUESTION", "APPLY_SUGGESTION", "SUBMIT_PRACTICE", "VERIFY_QUESTION", "MANUAL_NEW_CHAT", "RESOLVE_UNKNOWN_WEB", "CREATE_WEB_CONVERSATION",
  "CLEAR_REQUEST_CHECKPOINT", "RESOLVE_UNKNOWN_USAGE", "CONFIRM_VERIFICATION", "CLEAR_ANSWER_MEMORY", "CLEAR_ALL_DATA", "INDEX_COURSE_MATERIALS", "EXTRACT_COURSE_MATERIALS", "SEARCH_KNOWLEDGE", "CLEAR_KNOWLEDGE_INDEX",
  "LIST_WEB_TABS", "BIND_WEB_TABS", "CLEAR_WEB_TAB_BINDING", "CHECK_WEB_TAB_BINDING", "SCORM_CONTROL"
]);

function assertLiveWebAutomationAllowed(provider: AppSettings["provider"], fixture = false): void {
  if (provider !== "chatgpt_web" && provider !== "claude_web" && provider !== "gemini_web" && provider !== "deepseek_web") return;
  const policy = webAutomationPolicy(provider, fixture);
  if (!policy.canAutomate) throw new Error(policy.reason);
}

function runUsesWeb(run: RunSession): boolean {
  const provider = run.provider ?? run.settingsSnapshot?.provider;
  return provider ? isWebProvider(provider) : false;
}

function sameQuestionSnapshot(left: QuestionSnapshot, right: QuestionSnapshot): boolean {
  return left.id === right.id && left.type === right.type && left.prompt === right.prompt
    && left.options.length === right.options.length
    && left.options.every((option, index) => option.id === right.options[index]?.id && option.label === right.options[index]?.label)
    && left.images.length === right.images.length
    && left.images.every((image, index) => image.mimeType === right.images[index]?.mimeType && image.data === right.images[index]?.data);
}

async function getRunnableWebAdapter(provider: import("../src/types").WebProviderId, expectedTnuTabId?: number) {
  const tabs = await getBrowserTabSummaries();
  let binding = await getWebTabBinding();
  const status = binding ? validateStoredBinding(tabs, binding) : { valid: false };
  const bindingMatches = binding?.providerId === provider
    && (expectedTnuTabId === undefined || binding.tnuTabId === expectedTnuTabId)
    && status.valid;
  if (!bindingMatches) {
    if (expectedTnuTabId === undefined) throw new Error(status.reason || "Chưa liên kết tab TNU và tab AI.");
    binding = inferUniqueWebTabBinding(tabs, { tnuTabId: expectedTnuTabId, providerId: provider });
    await saveWebTabBinding(binding);
    await appendLog("info", `Đã tự liên kết tab TNU #${binding.tnuTabId} với ${provider} #${binding.aiTabId} vì chỉ có một tab phù hợp.`);
  }
  const resolvedBinding = binding;
  if (!resolvedBinding) throw new Error("Không thể xác định tab AI Web để liên kết.");
  assertLiveWebAutomationAllowed(provider, resolvedBinding.fixture === true);
  const adapter = resolvedBinding.fixture
    ? new FixtureTabWebAdapter(resolvedBinding.aiTabId, provider)
    : new LiveTabWebAdapter(resolvedBinding.aiTabId, provider);
  if (!await adapter.detect()) throw new Error("Tab AI đã bind không còn tồn tại hoặc đã đổi provider.");
  const providerStatus = await adapter.checkReady();
  if (providerStatus.state !== "ready" || !providerStatus.canAutomate) throw new Error(`${providerStatus.state.toUpperCase()}: ${providerStatus.message}`);
  const [tnuTab, aiTab] = await Promise.all([browser.tabs.get(resolvedBinding.tnuTabId), browser.tabs.get(resolvedBinding.aiTabId)]);
  if (tnuTab.windowId !== resolvedBinding.tnuWindowId || aiTab.windowId !== resolvedBinding.aiWindowId) throw new Error("Một tab đã chuyển cửa sổ; hãy bind lại trước khi chạy.");
  return { binding: resolvedBinding, adapter, conversationIdentity: await adapter.conversationIdentity() };
}

async function getBrowserTabSummaries() {
  const tabs = await browser.tabs.query({});
  return summarizeBrowserTabs(tabs);
}

async function invalidateWebTabBinding(tabId: number, event: "closed" | "reloaded"): Promise<void> {
  const binding = await getWebTabBinding();
  if (!binding || (binding.aiTabId !== tabId && binding.tnuTabId !== tabId)) return;
  await clearWebTabBinding();
  const run = await getRun();
  if (run?.aiTabId === tabId && ["answering", "preparing", "navigating"].includes(run.status)) {
    await mutateRun((current) => current?.id === run.id ? {
      ...current,
      executionEpoch: crypto.randomUUID(), status: "paused", conversationIdentity: undefined,
      webUnknownRequestId: runUsesWeb(current) && ["dispatching", "in_flight"].includes(current.activeExecution?.status ?? "") ? current.activeExecution?.requestId : current.webUnknownRequestId,
      activeExecution: current.activeExecution && ["dispatching", "in_flight"].includes(current.activeExecution.status) ? { ...current.activeExecution, status: "unknown" } : current.activeExecution,
      message: `Tab AI ${event === "closed" ? "đã đóng" : "đã tải lại"}; binding bị vô hiệu hóa. Hãy bind lại trước khi tiếp tục.`
    } : undefined);
    activeRequests.forEach((controller) => controller.abort());
    activeRequests.clear();
  }
  await appendLog("warning", `Binding tab AI/TNU bị xóa vì tab ${tabId} ${event === "closed" ? "đóng" : "tải lại"}.`);
}

async function handleWebTabUrlChange(tabId: number, url: string): Promise<void> {
  const binding = await getWebTabBinding();
  if (!binding || binding.aiTabId !== tabId) return;
  // Gemini/ChatGPT/Claude update the same tab URL when a new conversation is
  // created. That is expected SPA navigation, not a lost bridge or a new tab.
  if (!shouldInvalidateBindingForAiUrl(binding, tabId, url)) return;
  await invalidateWebTabBinding(tabId, "reloaded");
}
async function availableModels() {
  const signal = AbortSignal.timeout(12000);
  const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal });
  return listGeminiModels(await getApiKey(), timedFetch);
}

function assertExternalProvider(provider: string): asserts provider is ExternalApiProvider {
  if (provider !== "openai_api" && provider !== "anthropic_api") throw new Error("Nhà cung cấp API không hợp lệ.");
}

async function availableExternalModels(provider: ExternalApiProvider) {
  const signal = AbortSignal.timeout(12000);
  return listExternalModels(provider, await getProviderKey(provider), (input, init) => fetch(input, { ...init, signal }));
}

async function validateProviderSelection(settings: import("../src/types").AppSettings): Promise<void> {
  if (settings.provider === "gemini_api") return validateGeminiModel(selectedModel(settings));
  if (settings.provider === "openai_api" || settings.provider === "anthropic_api") {
    const model = selectedProviderModel(settings);
    if (!model) throw new Error("Hãy chọn model cho API trước.");
    if (!(await availableExternalModels(settings.provider)).some((item) => item.id === model)) throw new Error("Model API đã chọn không còn trong danh sách khả dụng.");
  }
}

async function validateGeminiModel(model: string): Promise<void> {
  if (!model) throw new Error("Hãy chọn model Gemini API trước.");
  const models = await availableModels();
  if (!models.some((item) => item.id === model)) throw new Error("Model Gemini đã chọn không khả dụng hoặc không hỗ trợ generateContent. Hãy chọn model khác.");
}

async function ensureExecution(runId: string, epoch: string): Promise<void> {
  if (!isCurrentExecution(await getRun(), runId, epoch)) throw new Error("Yêu cầu AI cũ đã bị hủy hiệu lực.");
}

function runRequestHooks(runId: string, epoch: string, requestId: string, question: QuestionSnapshot, knowledgeChunks: KnowledgeChunk[], cacheEvidence: string[], independent: boolean): RequestHooks {
  let active: { provider: ApiProviderId; model: string; reservationId: string } | undefined;
  const settle = async (usage?: ProviderUsage, definitelyRejected = false) => {
    const pending = active ? undefined : (await getRun())?.usage?.pending.find((item) => item.requestId === requestId);
    const identity = active ?? (pending ? { provider: pending.provider, model: pending.model, reservationId: pending.id } : undefined);
    if (!identity) return;
    await mutateRun((run) => run?.id === runId && run.usage?.pending.some((item) => item.id === identity.reservationId)
      ? { ...run, usage: settleUsage(run.usage, identity.provider, identity.model, usage, identity.reservationId, definitelyRejected) }
      : undefined);
    if (active?.reservationId === identity.reservationId) active = undefined;
  };
  const onUsage = async (usage?: ProviderUsage) => {
    await settle(usage);
    const checkpoint = await getCheckpoint();
    if (checkpoint?.requestId === requestId && ["in_flight", "unknown_delivery"].includes(checkpoint.phase)) await updateCheckpointState("completed");
  };
  const updateCheckpointState = (phase: import("../src/request-checkpoint").RequestPhase, reservationId?: string) => updateCheckpoint(requestId, phase, reservationId ? { reservationId } : {});
  return {
    beforeAttempt: async (provider, model) => {
      const updated = await mutateRun((run) => {
        if (!run || !isCurrentExecution(run, runId, epoch)) return undefined;
        const settings = run.settingsSnapshot ?? { ...DEFAULT_SETTINGS, maxRequests: 0, maxTokens: 0 };
        const reservationId = crypto.randomUUID();
        const evidence = independent ? [] : cacheEvidence;
        const projected = estimateRequestTokens(question, knowledgeChunks, evidence, settings, reservationId);
        const usage = reserveUsage(run.usage, settings, provider, model, projected, reservationId, Date.now(), requestId, question.id);
        return { ...run, usage };
      });
      if (!updated) throw new ApiError("Phiên đã dừng trước khi gửi yêu cầu.", "cancelled");
      const pending = updated.usage?.pending?.at(-1);
      if (!pending) throw new ApiError("Không thể tạo ngân sách tạm giữ cho yêu cầu.", "budget");
      active = { provider, model, reservationId: pending.id };
      await updateCheckpointState("reserved", pending.id);
    },
    onDispatch: async () => {
      const identity = active;
      if (!identity) throw new ApiError("Thiếu khoản ngân sách tạm giữ trước khi gửi.", "budget");
      const updated = await mutateRun((run) => run?.id === runId && isCurrentExecution(run, runId, epoch) && run.usage ? { ...run, usage: updateReservationStatus(run.usage, identity.reservationId, "dispatching") } : undefined);
      if (!updated) throw new ApiError("Phiên đã dừng trước khi gửi yêu cầu.", "cancelled");
      await updateCheckpointState("dispatching", identity.reservationId);
    },
    onInFlight: async () => {
      const identity = active;
      if (!identity) return;
      const updated = await mutateRun((run) => run?.id === runId && run.usage ? { ...run, usage: updateReservationStatus(run.usage, identity.reservationId, "in_flight") } : undefined);
      if (!updated) throw new ApiError("Không thể lưu trạng thái yêu cầu đang chạy.", "invalid_response");
      await updateCheckpointState("in_flight", identity.reservationId);
    },
    onNotSent: async () => {
      const identity = active;
      if (identity) {
        active = undefined;
        await mutateRun((run) => run?.id === runId && run.usage ? { ...run, usage: releaseUnsentReservation(run.usage, identity.reservationId) } : undefined);
      }
      const checkpoint = await getCheckpoint();
      if (checkpoint?.requestId === requestId && checkpoint.phase === "unknown_delivery") await clearCheckpoint();
      else if (checkpoint?.requestId === requestId && checkpoint.phase !== "rejected") await updateCheckpointState("rejected", identity?.reservationId);
    },
    onUsage,
    onUnknown: async () => {
      const identity = active;
      if (identity) {
        active = undefined;
        await mutateRun((run) => run?.id === runId && run.usage ? { ...run, usage: markUnknownUsage(run.usage, identity.provider, identity.model, identity.reservationId, requestId) } : undefined);
      }
      const checkpoint = await getCheckpoint();
      if (checkpoint?.requestId === requestId && checkpoint.phase !== "unknown_delivery") await updateCheckpointState("unknown_delivery", identity?.reservationId);
    },
    onRejected: async () => {
      await settle(undefined, true);
      const checkpoint = await getCheckpoint();
      if (checkpoint?.requestId === requestId && checkpoint.phase !== "rejected") await updateCheckpointState("rejected");
    }
  };
}

async function requestApiWithFallback(params: { runId: string; epoch: string; requestId: string; provider: ApiProviderId; settings: AppSettings; question: QuestionSnapshot; knowledgeChunks: KnowledgeChunk[]; cacheEvidence: string[]; independent: boolean; controller: AbortController; hooks: RequestHooks }) {
  const { runId, epoch, requestId, settings, question, knowledgeChunks, cacheEvidence, independent, controller, hooks } = params;
  let provider = params.provider;
  let model = selectedProviderModel(settings, provider);
  const others = settings.fallbackEnabled ? (settings.fallbackOrder ?? []).filter((id) => id !== provider).slice(0, Math.max(0, settings.fallbackMax ?? 0)) : [];
  for (;;) {
    const apiKey = provider === "gemini_api" ? await getApiKey() : await getProviderKey(provider);
    if (!apiKey || !model) throw new ApiError("Chưa cấu hình API key hoặc model cho AI đã chọn.", "invalid_request");
    try {
      const decision = provider === "gemini_api"
        ? await answerWithGemini(apiKey, settings, question, controller.signal, fetch, independent, knowledgeChunks, independent ? [] : cacheEvidence, hooks)
        : await answerWithExternalApi({ provider, apiKey, model, requestId, settings, question, knowledgeChunks, cacheEvidence, independent }, controller.signal, fetch, hooks);
      return { decision, provider, model };
    } catch (error) {
      // A confirmed 429 means the provider rejected the request. Network failures and 5xx may have been delivered.
      if (error instanceof ApiError) {
        await mutateRun((run) => isCurrentExecution(run, runId, epoch) ? { ...run!, lastError: { provider, model, kind: error.kind, status: error.status, providerCode: error.providerCode, at: new Date().toISOString() } } : undefined);
      }
      if (!(error instanceof ApiError) || !error.definitelyRejected || !error.fallbackAllowed || controller.signal.aborted) throw error;
      let next: ApiProviderId | undefined;
      while (others.length && !next) {
        const candidate = others.shift()!;
        try {
          await validateProviderSelection({ ...settings, provider: candidate });
          const candidateModel = selectedProviderModel(settings, candidate);
          if (supportsVerifiedTask(await getModelCapabilities(), candidate, candidateModel, question.images.length > 0, Date.now(), candidate === "openai_api" && settings.openaiStructuredOutputs)) {
            const run = await getRun();
            const projected = estimateRequestTokens(question, knowledgeChunks, independent ? [] : cacheEvidence, settings, requestId);
            reserveUsage(run?.usage, run?.settingsSnapshot ?? settings, candidate, candidateModel, projected, "fallback-preflight");
            next = candidate;
          }
        } catch (candidateError) {
          if (candidateError instanceof ApiError && candidateError.kind === "budget") throw candidateError;
          /* unavailable or unverified candidate, try next configured one */
        }
        if (controller.signal.aborted) throw new ApiError("Đã dừng trước khi chuyển AI.", "cancelled");
      }
      if (!next) throw error;
      await ensureExecution(runId, epoch);
      const nextModel = selectedProviderModel(settings, next);
      await retargetRejectedCheckpoint(requestId, next, nextModel);
      const changed = await mutateRun((run) => isCurrentExecution(run, runId, epoch) && run?.activeExecution?.requestId === requestId ? { ...run, usage: run.usage ? incrementFallbackCount(run.usage) : run.usage, activeExecution: { ...run.activeExecution, providerId: next!, modelId: nextModel }, message: `AI dự phòng ${next} đang xử lý câu hỏi sau lỗi ${error.providerCode ?? error.status}.` } : undefined);
      if (!changed || controller.signal.aborted) throw new ApiError("Phiên đã dừng trước khi chuyển AI.", "cancelled");
      provider = next;
      model = nextModel;
      await appendLog("warning", `Đã chuyển AI dự phòng sang ${provider}, model ${model}, sau lỗi ${error.providerCode ?? error.status}.`);
    }
  }
}

async function reserveAnswer(run: RunSession, questionId: string, epoch: string, settings: import("../src/types").AppSettings): Promise<NonNullable<RunSession["activeExecution"]>> {
  const providerId = run.provider ?? settings.provider;
  const execution: NonNullable<RunSession["activeExecution"]> = { requestId: crypto.randomUUID(), executionEpoch: epoch, questionId, providerId, modelId: selectedProviderModel(settings, providerId), status: "waiting" };
  const reserved = await mutateRun((current) => {
    if (!isCurrentExecution(current, run.id, epoch) || !current || current.processedQuestionIds.includes(questionId)) return undefined;
    const previous = current.activeExecution;
    if (previous?.executionEpoch === epoch && (previous.status === "waiting" || previous.questionId === questionId)) return undefined;
    return { ...current, activeExecution: execution };
  });
  if (!reserved) throw new Error("Câu hỏi đã được xử lý hoặc đang có yêu cầu AI khác trong phiên.");
  return execution;
}

async function completeExecution(runId: string, epoch: string, requestId: string): Promise<void> {
  const updated = await mutateRun((current) => isCurrentExecution(current, runId, epoch) && current?.activeExecution?.requestId === requestId && ["waiting", "dispatching", "in_flight"].includes(current.activeExecution.status) ? { ...current, activeExecution: { ...current.activeExecution, status: "completed" } } : undefined);
  if (!updated) throw new Error("Yêu cầu AI không còn hiệu lực.");
}

async function activeTnuTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://tnu.aum.edu.vn/")) {
    throw new Error("Hãy mở một trang TNU trong tab hiện tại.");
  }
  return tab;
}

async function sendToActiveTab<T>(message: unknown): Promise<T> {
  const run = await getRun();
  if (!run?.tnuTabId) throw new Error("Phiên chưa gắn với tab TNU. Hãy bắt đầu phiên mới.");
  const tab = await browser.tabs.get(run.tnuTabId).catch(() => undefined);
  if (!tab?.id || !tab.url?.startsWith("https://tnu.aum.edu.vn/")) throw new Error("Tab TNU của phiên đã đóng hoặc chuyển sang trang khác.");
  const result = await browser.tabs.sendMessage(tab.id!, message) as T;
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const response = result as { error?: string };
    throw new Error(response.error || "Tab TNU không thực hiện được yêu cầu.");
  }
  return result;
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

async function pauseInterruptedRun(runId: string, message: string, request?: import("../src/request-checkpoint").RequestCheckpoint): Promise<void> {
  await mutateRun((run) => {
    if (!run || run.id !== runId) return undefined;
    let usage = run.usage;
    if (request && usage) {
      const pending = usage.pending.find((item) => item.id === request.reservationId || item.requestId === request.requestId)
        ?? (request.providerId && request.modelId ? [...usage.pending].reverse().find((item) => item.provider === request.providerId && item.model === request.modelId && item.status !== "unknown") : undefined);
      if (pending) usage = markUnknownUsage(usage, pending.provider, pending.model, pending.id, request.requestId);
    }
    const nextEpoch = crypto.randomUUID();
    const pendingDecisionRequestId = run.pendingDecision?.decision.executionRequestId;
    const retainedDecisionExecution = pendingDecisionRequestId ? {
      requestId: pendingDecisionRequestId, executionEpoch: nextEpoch,
      questionId: run.pendingDecision!.question.id,
      providerId: (run.activeExecution?.providerId ?? run.provider ?? "gemini_api") as ApiProviderId,
      modelId: run.activeExecution?.modelId ?? "",
      status: "completed" as const
    } : undefined;
    return {
      ...run, executionEpoch: nextEpoch, status: run.pendingDecision ? "awaiting_user" : "paused",
      activeExecution: retainedDecisionExecution, usage,
      error: undefined, message
    };
  });
}

async function stopRequestCheckpoint(runId: string): Promise<void> {
  const checkpoint = await getCheckpoint();
  if (!checkpoint || checkpoint.runId !== runId) return;
  if (["prepared", "reserved", "rejected"].includes(checkpoint.phase)) {
    if (checkpoint.phase === "reserved" && checkpoint.reservationId) {
      await mutateRun((run) => run?.id === runId && run.usage ? { ...run, usage: releaseUnsentReservation(run.usage, checkpoint.reservationId!) } : undefined);
    }
    await clearCheckpoint();
    return;
  }
  if (["dispatching", "in_flight", "sending", "waiting", "unknown_delivery"].includes(checkpoint.phase)) {
    await pauseInterruptedRun(runId, "Yêu cầu đã bắt đầu; chưa xác định được usage. Đối soát trước khi gửi tiếp.", checkpoint);
    if (checkpoint.phase !== "unknown_delivery") await updateCheckpoint(checkpoint.requestId, "unknown_delivery").catch(() => undefined);
  } else if (checkpoint.phase === "completed") {
    const run = await getRun();
    if (run?.id === runId && !run.pendingDecision && !run.processedQuestionIds.includes(checkpoint.questionId)) {
      await mutateRun((current) => current?.id === runId ? {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", activeExecution: undefined,
        processedQuestionIds: [...new Set([...current.processedQuestionIds, checkpoint.questionId])],
        message: "Phản hồi đã hoàn tất nhưng phiên dừng trước khi lưu kết quả; câu này sẽ không tự gửi lại. Kiểm tra trang TNU trước khi tiếp tục."
      } : undefined);
    }
  }
}

async function settleCheckpointFailure(runId: string, requestId: string, error: unknown): Promise<void> {
  const checkpoint = await getCheckpoint();
  if (!checkpoint || checkpoint.runId !== runId || checkpoint.requestId !== requestId) {
    const run = await getRun();
    const activeId = run?.activeExecution?.requestId;
    if (run?.id === runId && activeId && (activeId === requestId || requestId.startsWith(`${activeId}:`))) {
      await pauseInterruptedRun(runId, "Không thể lưu trạng thái request; phiên đã dừng trước khi thử lại. Kiểm tra nhật ký và tiếp tục thủ công.");
    }
    return;
  }
  if (checkpoint.phase === "completed") {
    const run = await getRun();
    if (run?.id === runId && !run.pendingDecision && !["paused", "completed", "error"].includes(run.status)) {
      await pauseInterruptedRun(runId, "API đã phản hồi nhưng không tạo được đáp án hoàn chỉnh; phiên đã dừng để tránh gửi lại tự động.", checkpoint);
    }
    return;
  }
  if (["prepared", "reserved", "rejected"].includes(checkpoint.phase)) {
    if (checkpoint.phase === "reserved" && checkpoint.reservationId) {
      await mutateRun((run) => run?.id === runId && run.usage ? { ...run, usage: releaseUnsentReservation(run.usage, checkpoint.reservationId!) } : undefined);
    }
    await clearRejectedCheckpoint(requestId);
    await pauseInterruptedRun(runId, "Request chưa được gửi hoặc đã bị nhà cung cấp từ chối; có thể tiếp tục sau khi kiểm tra cấu hình.");
    return;
  }
  if (error instanceof ApiError && error.definitelyRejected && checkpoint.phase === "rejected") {
    await clearRejectedCheckpoint(requestId);
    return;
  }
  await pauseInterruptedRun(runId, "Yêu cầu đã bắt đầu nhưng kết quả/usage chưa được xác nhận. Đối soát trước khi gửi lại.", checkpoint);
  if (checkpoint.phase !== "unknown_delivery") await updateCheckpoint(requestId, "unknown_delivery").catch(() => undefined);
}

async function recoverInterruptedCheckpoint(): Promise<void> {
  const checkpoint = await getCheckpoint();
  const run = await getRun();
  // The API checkpoint is stored separately and may belong to a finished
  // earlier session. An active Web delivery in the current durable run must
  // always be reconciled first after an MV3 worker restart.
  if (run && runUsesWeb(run) && run.activeExecution && ["dispatching", "in_flight"].includes(run.activeExecution.status)) {
    const active = run.activeExecution;
    await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === active.requestId ? {
      ...current, executionEpoch: crypto.randomUUID(), status: "paused", webUnknownRequestId: active.requestId,
      activeExecution: { ...active, status: "unknown" },
      message: "Worker khởi động lại sau khi có thể đã gửi AI Web. Kết quả chưa xác định; kiểm tra tab AI trước khi tiếp tục."
    } : undefined);
    await appendLog("warning", `Worker restart trong request AI Web ${active.requestId}; không tự gửi lại.`);
    return;
  }
  if (!checkpoint) {
    if (!run || !runUsesWeb(run) || !run.activeExecution) return;
    const active = run.activeExecution;
    if (active.status === "dispatching" || active.status === "in_flight") {
      await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === active.requestId ? {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", webUnknownRequestId: active.requestId,
        activeExecution: { ...active, status: "unknown" },
        message: "Worker khởi động lại sau khi có thể đã gửi AI Web. Kết quả chưa xác định; kiểm tra tab AI trước khi tiếp tục."
      } : undefined);
      await appendLog("warning", `Worker restart trong request AI Web ${active.requestId}; không tự gửi lại.`);
      return;
    }
    if (active.status === "waiting") {
      await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === active.requestId ? {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", activeExecution: undefined,
        message: "Worker khởi động lại trước khi dispatch AI Web; request chưa được gửi và có thể tiếp tục an toàn."
      } : undefined);
    } else if (active.status === "completed" && run.webCompletedResponse && !run.processedQuestionIds.includes(active.questionId)) {
      await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === active.requestId ? {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", activeExecution: { ...active, executionEpoch: current.executionEpoch ?? active.executionEpoch },
        message: "Worker khởi động lại sau khi AI trả lời; phản hồi đã lưu và sẽ được dùng lại sau khi Resume, không gửi request mới."
      } : undefined);
    } else if (active.status === "completed" && !run.processedQuestionIds.includes(active.questionId)) {
      await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === active.requestId ? {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", webUnknownRequestId: active.requestId,
        activeExecution: { ...active, status: "unknown" },
        message: "Worker khởi động lại sau khi AI Web trả lời nhưng trước khi phản hồi được lưu. Kết quả chưa xác định; không tự gửi lại."
      } : undefined);
    }
    return;
  }
  if (!run || run.id !== checkpoint.runId) return;
  if (["prepared", "reserved", "rejected"].includes(checkpoint.phase)) {
    if (checkpoint.phase === "reserved" && checkpoint.reservationId) {
      await mutateRun((current) => current?.id === run.id && current.usage ? { ...current, usage: releaseUnsentReservation(current.usage, checkpoint.reservationId!) } : undefined);
    }
    await clearCheckpoint();
    await pauseInterruptedRun(run.id, "Worker được khởi động lại trước khi gửi request; đã hoàn reservation và có thể tiếp tục an toàn.");
    return;
  }
  if (["dispatching", "in_flight", "sending", "waiting", "unknown_delivery"].includes(checkpoint.phase)) {
    await pauseInterruptedRun(run.id, "Worker được khởi động lại sau thời điểm gửi có thể đã bắt đầu; usage chưa rõ và request sẽ không được gửi lại tự động.", checkpoint);
    if (checkpoint.phase !== "unknown_delivery") await updateCheckpoint(checkpoint.requestId, "unknown_delivery").catch(() => undefined);
    return;
  }
  if (checkpoint.phase === "completed" && !run.pendingDecision && !run.processedQuestionIds.includes(checkpoint.questionId)) {
    await mutateRun((current) => current?.id === run.id ? {
      ...current, executionEpoch: crypto.randomUUID(), status: "paused", activeExecution: undefined,
      processedQuestionIds: [...new Set([...current.processedQuestionIds, checkpoint.questionId])],
      message: "Worker được khởi động lại sau khi API hoàn tất; đã ghi nhận câu hiện tại để tránh gửi lặp. Kiểm tra trang TNU trước khi tiếp tục."
    } : undefined);
  }
}

let recoveryPromise: Promise<void> | undefined;
function ensureRecovered(): Promise<void> {
  recoveryPromise ??= recoverInterruptedCheckpoint().catch((error) => {
    recoveryPromise = undefined;
    throw error;
  });
  return recoveryPromise;
}

export async function handleTnuTabLifecycleEvent(tabId: number, event: "closed" | "reloaded"): Promise<void> {
  const run = await getRun();
  if (!run || run.tnuTabId !== tabId || (!activeRequests.size && run.activeExecution?.status !== "waiting")) return;
  const reason = event === "closed" ? "Tab TNU đã đóng khi request đang chạy; phản hồi cũ sẽ không được áp dụng." : "Tab TNU đang tải lại khi request chạy; phản hồi của document cũ sẽ bị loại bỏ.";
  const checkpoint = await getCheckpoint();
  if (runUsesWeb(run) && ["dispatching", "in_flight"].includes(run.activeExecution?.status ?? "")) {
    await mutateRun((current) => {
      const active = current?.activeExecution;
      if (!current || current.id !== run.id || !active || active.requestId !== run.activeExecution?.requestId) return undefined;
      return {
        ...current, executionEpoch: crypto.randomUUID(), status: "paused", webUnknownRequestId: active.requestId,
        activeExecution: { ...active, status: "unknown" }, message: `${reason} Request AI Web chưa được xác định; không gửi lại tự động.`
      };
    });
  } else await pauseInterruptedRun(run.id, reason, checkpoint?.runId === run.id ? checkpoint : undefined);
  activeRequests.forEach((controller) => controller.abort());
  activeRequests.clear();
  await stopRequestCheckpoint(run.id);
  await appendLog("warning", reason);
}

async function handle(message: RuntimeMessage, sender: Browser.runtime.MessageSender): Promise<RuntimeResponse> {
  const fromTnuContent = sender.url?.startsWith("https://tnu.aum.edu.vn/") === true && sender.tab?.id !== undefined;
  const fromExtension = isExtensionPage(sender);
  if (!fromExtension && !fromTnuContent) throw new Error("Nguồn thông điệp không thuộc extension hoặc tab TNU được hỗ trợ.");
  if (fromTnuContent && !CONTENT_MESSAGE_TYPES.has(message.type)) throw new Error("Trang TNU không được phép thay đổi cấu hình, API key hoặc điều khiển extension.");
  if (EXTENSION_ONLY_TYPES.has(message.type) && !fromExtension) throw new Error("Thao tác này chỉ được phép từ giao diện extension.");
  if (await getCredentialChangeLease() && ["SWITCH_PROVIDER", "SELECT_GEMINI_MODEL", "LIST_PROVIDER_MODELS", "SELECT_PROVIDER_MODEL", "TEST_API_CAPABILITY", "LIST_MODELS", "VALIDATE_API_KEY", "START_RUN", "RESUME_RUN"].includes(message.type)) {
    throw new Error("Đang thay API key; hãy hoàn tất thao tác đó trước khi gọi hoặc kiểm tra API.");
  }
  if (fromTnuContent && ["ANSWER_QUESTION", "UPDATE_RUN"].includes(message.type)) {
    const run = await getRun();
    if (!run?.tnuTabId || sender.tab?.id !== run.tnuTabId) {
      throw new Error("Thông điệp không đến từ tab TNU của phiên hiện tại.");
    }
  }
  await ensureRecovered();
  switch (message.type) {
    case "GET_STATE": {
      const state = await getState();
      if (sender.tab && sender.url?.startsWith("https://tnu.aum.edu.vn/") && state.run?.tnuTabId !== sender.tab.id) state.run = undefined;
      state.browserTabs = await getBrowserTabSummaries();
      state.webTabBinding = await getWebTabBinding();
      return { ok: true, data: state };
    }
    case "LIST_WEB_TABS":
      return { ok: true, data: await getBrowserTabSummaries() };
    case "BIND_WEB_TABS": {
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi đổi tab TNU hoặc AI.");
      const tabs = await getBrowserTabSummaries();
      const binding = validateWebTabBinding(tabs, message);
      await saveWebTabBinding(binding);
      const settings = await getSettings();
      await saveSettings({ ...settings, provider: message.providerId, selectionRevision: crypto.randomUUID() });
      const existingRun = await getRun();
      if (existingRun && ["paused", "error", "completed"].includes(existingRun.status)) {
        await mutateRun((current) => current?.id === existingRun.id && canChangeSelection(current) ? {
          ...current,
          tnuTabId: binding.tnuTabId, tnuWindowId: binding.tnuWindowId,
          aiTabId: binding.aiTabId, aiWindowId: binding.aiWindowId,
          conversationIdentity: undefined, webFixture: binding.fixture, webCompletedCount: 0,
          message: "Tab TNU/AI đã được liên kết lại. Kiểm tra provider và Resume để tiếp tục."
        } : undefined);
      }
      await appendLog("info", `Đã bind tab TNU #${binding.tnuTabId} (cửa sổ ${binding.tnuWindowId}) với ${binding.providerId} #${binding.aiTabId} (cửa sổ ${binding.aiWindowId}).`);
      return { ok: true, data: binding };
    }
    case "CHECK_WEB_TAB_BINDING": {
      const binding = await getWebTabBinding();
      if (!binding) return { ok: true, data: { valid: false, reason: "Chưa bind tab TNU và tab AI." } };
      const validity = validateStoredBinding(await getBrowserTabSummaries(), binding);
      if (!validity.valid) return { ok: true, data: { ...validity, binding } };
      try {
        const web = await getRunnableWebAdapter(binding.providerId, binding.tnuTabId);
        return { ok: true, data: { valid: true, reason: binding.fixture ? "Local fixture đã sẵn sàng." : "Editor, provider và chat identity của tab AI đã sẵn sàng.", binding, status: await web.adapter.checkReady(), conversationIdentity: web.conversationIdentity } };
      } catch (error) {
        return { ok: true, data: { valid: false, reason: error instanceof Error ? error.message : String(error), binding } };
      }
    }
    case "CLEAR_WEB_TAB_BINDING":
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi xóa binding tab.");
      await clearWebTabBinding();
      return { ok: true };
    case "SCORM_STATUS_UPDATE": {
      if (!sender.tab?.id || !sender.url || (!sender.url.includes("/mod/scorm/loadSCO.php") && !sender.url.includes("/mod_scorm/content/"))) throw new Error("Trạng thái không đến từ frame SCORM hợp lệ.");
      await saveScormStatus({ ...message.status, tabId: sender.tab.id });
      return { ok: true };
    }
    case "SCORM_CONTROL": {
      const current = await getSettings();
      const rates = [1, 1.5, 2, 3, 4, 6, 8];
      const scorm = {
        scormEnabled: message.settings.scormEnabled === true,
        scormPlaybackRate: rates.includes(message.settings.scormPlaybackRate) ? message.settings.scormPlaybackRate : 1,
        scormAutoNext: message.settings.scormAutoNext !== false,
        scormNextDelayMs: Number.isFinite(message.settings.scormNextDelayMs) ? Math.max(0, Math.min(10_000, message.settings.scormNextDelayMs)) : 750,
        scormPauseOnInteraction: message.settings.scormPauseOnInteraction !== false
      };
      await saveSettings({ ...current, ...scorm });
      const tabs = await browser.tabs.query({ url: "https://tnu.aum.edu.vn/mod/scorm/player.php*" });
      await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [browser.tabs.sendMessage(tab.id, { type: "SCORM_APPLY_SETTINGS", settings: scorm } satisfies RuntimeMessage).catch(() => undefined)]));
      await appendLog(scorm.scormEnabled ? "success" : "info", scorm.scormEnabled ? `Đã bật tăng tốc bài giảng ${scorm.scormPlaybackRate}×${scorm.scormAutoNext ? " và tự chuyển slide" : ""}.` : "Đã tắt tăng tốc bài giảng điện tử.");
      return { ok: true, data: scorm };
    }
    case "SAVE_SETTINGS": {
      const selected = await getSettings();
      const savedSettings = { ...message.settings, provider: selected.provider, model: selected.model, customModel: selected.customModel, openaiModel: selected.openaiModel, anthropicModel: selected.anthropicModel, selectionRevision: selected.selectionRevision };
      await saveSettings(savedSettings);
      // Practice controls are operational settings: saving them while a
      // practice is already open must affect that run as users expect.
      await mutateRun((run) => {
        if (!run || run.target.assessmentKind !== "practice" || run.dryRunLimit) return run;
        const currentAutomation = run.practiceAutomation;
        const practiceAutomation = savedSettings.practiceFullScoreEnabled
          ? {
              enabled: true as const,
              autoSubmit: savedSettings.practiceAutoSubmit,
              collectCacheWhenFull: savedSettings.practiceCollectCacheWhenFull,
              maxAttempts: savedSettings.practiceMaxAttempts,
              attemptNumber: currentAutomation?.attemptNumber ?? 1,
              webRetryCount: savedSettings.webAutoRetryCount,
              scoreHistory: currentAutomation?.scoreHistory ?? [],
              submitPhase: currentAutomation?.submitPhase ?? "idle" as const
            }
          : undefined;
        return { ...run, settingsSnapshot: { ...run.settingsSnapshot, ...savedSettings }, practiceAutomation, updatedAt: new Date().toISOString() };
      });
      return { ok: true };
    }
    case "SWITCH_PROVIDER": {
      getProvider(message.provider);
      const settings = await getSettings();
      if (settings.provider === message.provider) return { ok: true, data: settings };
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi đổi AI.");
      await validateProviderSelection({ ...settings, provider: message.provider });
      const next = { ...settings, provider: message.provider, selectionRevision: crypto.randomUUID() };
      await saveSettings(next);
      return { ok: true, data: next };
    }
    case "SELECT_GEMINI_MODEL": {
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi đổi model.");
      const model = message.model.replace(/^models\//, "").trim();
      await validateGeminiModel(model);
      const settings = await getSettings();
      if (selectedModel(settings) === model) return { ok: true, data: settings };
      const next = { ...settings, model, customModel: "" };
      await saveSettings(next);
      return { ok: true, data: next };
    }
    case "BEGIN_CREDENTIAL_CHANGE": {
      if (!["gemini_api", "openai_api", "anthropic_api"].includes(message.provider)) throw new Error("Nhà cung cấp API không hợp lệ.");
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi thay API key.");
      const activeLease = await getCredentialChangeLease();
      if (activeLease) throw new Error("Một thao tác thay API key khác đang chờ hoàn tất.");
      const token = crypto.randomUUID();
      await saveCredentialChangeLease({ token, provider: message.provider, expiresAt: Date.now() + 5 * 60_000 });
      return { ok: true, data: { token } };
    }
    case "COMPLETE_CREDENTIAL_CHANGE": {
      const lease = await getCredentialChangeLease();
      if (!lease || lease.token !== message.token || lease.provider !== message.provider) throw new Error("Phiên thay API key không còn hiệu lực.");
      if (!canChangeSelection(await getRun())) { await clearCredentialChangeLease(); throw new Error("Hãy dừng phiên trước khi thay API key."); }
      await clearProviderCapabilities(message.provider);
      await clearCredentialChangeLease();
      await appendLog("info", `Đã cập nhật thông tin xác minh sau khi thay API key cho ${message.provider}.`);
      return { ok: true };
    }
    case "CANCEL_CREDENTIAL_CHANGE": {
      const lease = await getCredentialChangeLease();
      if (lease?.token === message.token) await clearCredentialChangeLease();
      return { ok: true };
    }
    case "LIST_PROVIDER_MODELS": {
      assertExternalProvider(message.provider);
      return { ok: true, data: await availableExternalModels(message.provider) };
    }
    case "TEST_API_CAPABILITY": {
      const provider = message.provider;
      if (!["gemini_api", "openai_api", "anthropic_api"].includes(provider)) throw new Error("API không hợp lệ.");
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi thử kết nối API.");
      const settings = await getSettings();
      await validateProviderSelection({ ...settings, provider });
      const model = selectedProviderModel(settings, provider);
      const apiKey = provider === "gemini_api" ? await getApiKey() : await getProviderKey(provider);
      const question = capabilityQuestion(message.image);
      const safeSettings = { ...settings, apiPrompt: "Trả lời chính xác câu hỏi mẫu.", retryCount: 0 };
      let usage: ProviderUsage | undefined;
      const hooks: RequestHooks = { onUsage: async (value) => { usage = value; } };
      const signal = AbortSignal.timeout(settings.timeoutMs);
      let decision;
      try {
        decision = provider === "gemini_api"
          ? await answerWithGemini(apiKey, safeSettings, question, signal, fetch, false, [], [], hooks)
          : await answerWithExternalApi({ provider, apiKey, model, requestId: crypto.randomUUID(), settings: safeSettings, question, knowledgeChunks: [], cacheEvidence: [] }, signal, fetch, hooks);
      } catch (error) {
        await recordModelCapability(provider, model, message.image, false, provider === "openai_api" && safeSettings.openaiStructuredOutputs);
        throw error;
      }
      const answerMatchesFixture = decision.selectedOptionIds.length === 1 && decision.selectedOptionIds[0] === "option_1";
      await recordModelCapability(provider, model, message.image, answerMatchesFixture, provider === "openai_api" && safeSettings.openaiStructuredOutputs);
      return { ok: true, data: { provider, model, image: message.image, schemaValid: true, answerMatchesFixture, usage } };
    }
    case "SELECT_PROVIDER_MODEL": {
      assertExternalProvider(message.provider);
      if (!canChangeSelection(await getRun())) throw new Error("Hãy dừng phiên trước khi đổi model.");
      const model = message.model.trim();
      if (!model || !(await availableExternalModels(message.provider)).some((item) => item.id === model)) throw new Error("Model không nằm trong danh sách API khả dụng.");
      const settings = await getSettings();
      const next = message.provider === "openai_api" ? { ...settings, openaiModel: model } : { ...settings, anthropicModel: model };
      await saveSettings(next);
      return { ok: true, data: next };
    }
    case "LIST_MODELS": {
      const models = await availableModels();
      return { ok: true, data: models };
    }
    case "VALIDATE_API_KEY": {
      const models = await availableModels();
      return { ok: true, data: { modelCount: models.length } };
    }
    case "SCAN_COURSES": {
      await appendLog("info", "Bắt đầu quét khóa học TNU.");
      const tab = await activeTnuTab();
      const result = await browser.tabs.sendMessage(tab.id!, { type: "SCAN_COURSES" }) as RuntimeResponse<CourseIndex>;
      if (!result.ok || !result.data) throw new Error(result.error || "Không thể quét khóa học.");
      await saveCourseIndex(result.data);
      await appendLog("success", `Đã quét ${result.data.courses.length} khóa học.`);
      return { ok: true, data: result.data };
    }
    case "SAVE_QUEUE":
      await saveQueue(message.queue);
      return { ok: true };
    case "START_RUN": {
      if (await getCredentialChangeLease()) throw new Error("Đang thay API key; hãy hoàn tất thao tác đó trước khi bắt đầu phiên.");
      const existing = await getRun();
      if (existing && !["idle", "paused", "completed", "error"].includes(existing.status)) throw new Error("Đang có phiên khác. Hãy dừng phiên hiện tại trước khi bắt đầu bài mới.");
      if (!isSupportedQuizTarget(message.target.url)) throw new Error("URL bài học không hợp lệ. Hãy chọn đúng liên kết bài quiz trên TNU.");
      const settingsSnapshot = await getSettings();
      const tab = message.tnuTabId === undefined ? await activeTnuTab() : await browser.tabs.get(message.tnuTabId);
      if (!tab?.id || !tab.url?.startsWith("https://tnu.aum.edu.vn/")) throw new Error("Tab TNU đã chọn không còn hợp lệ.");
      const webExecution = isWebProvider(settingsSnapshot.provider)
        ? await getRunnableWebAdapter(settingsSnapshot.provider, tab.id)
        : undefined;
      const initialConversationIdentity = webExecution
        ? await createVerifiedConversation(webExecution.adapter)
        : undefined;
      if (message.mode === "from_current" && !isAttemptForTarget(tab.url ?? "", message.target.url)) {
        throw new Error("“Từ câu hiện tại” chỉ dùng khi tab đang mở đúng bài đã chọn. Hãy mở đúng bài rồi thử lại.");
      }
      const requestedMemoryKeys = [...new Set(message.memorySourceQuizKeys)];
      if (requestedMemoryKeys.length) {
        const availableKeys = new Set((await getAnswerMemory()).filter((entry) => entry.courseId === message.target.courseId).map((entry) => entry.quizKey));
        if (requestedMemoryKeys.some((key) => !availableKeys.has(key))) throw new Error("Có phần đáp án đã chọn không còn tồn tại trong bộ nhớ.");
      }
      const batchTargets = message.batchTargets?.length ? message.batchTargets : undefined;
      if (message.dryRunLimit !== undefined && (!Number.isInteger(message.dryRunLimit) || message.dryRunLimit < 1 || message.dryRunLimit > 20 || batchTargets || message.mode !== "from_current")) throw new Error("Chạy thử chỉ hỗ trợ 1–20 câu trên trang làm bài hiện tại; hãy chọn Từ câu hiện tại.");
      const batchIssue = batchTargets ? practiceBatchIssue(batchTargets) : undefined;
      if (batchIssue) throw new Error(batchIssue);
      if (batchTargets && (message.mode !== "from_start" || batchTargets[0]?.id !== message.target.id || new Set(batchTargets.map((target) => target.id)).size !== batchTargets.length)) {
        throw new Error("Chuỗi luyện tập không hợp lệ. Hãy chọn lại danh sách bài.");
      }
      const requestedMaterialIds = [...new Set(message.knowledgeMaterialIds)];
      if (requestedMaterialIds.length) {
        const knowledgeIndex = await getKnowledgeIndex(message.target.courseId);
        const indexedIds = new Set(knowledgeIndex?.chunks.map((chunk) => chunk.materialId) ?? []);
        if (requestedMaterialIds.some((id) => !indexedIds.has(id))) throw new Error("Có tài liệu đã chọn chưa được lập chỉ mục. Hãy cập nhật kho tài liệu rồi thử lại.");
      }
      const now = new Date().toISOString();
      const isPracticeBatch = Boolean(batchTargets);
      const practiceAutomation = settingsSnapshot.practiceFullScoreEnabled && message.target.assessmentKind === "practice" && !message.dryRunLimit
        ? { enabled: true as const, autoSubmit: settingsSnapshot.practiceAutoSubmit, collectCacheWhenFull: settingsSnapshot.practiceCollectCacheWhenFull, maxAttempts: settingsSnapshot.practiceMaxAttempts, attemptNumber: 1, webRetryCount: settingsSnapshot.webAutoRetryCount, scoreHistory: [], submitPhase: "idle" as const }
        : undefined;
      const run: RunSession = {
        id: crypto.randomUUID(), sessionId: crypto.randomUUID(), executionEpoch: crypto.randomUUID(), tnuTabId: tab.id, tnuWindowId: tab.windowId, aiTabId: webExecution?.binding.aiTabId, aiWindowId: webExecution?.binding.aiWindowId, conversationIdentity: initialConversationIdentity, webFixture: webExecution?.binding.fixture, webCompletedCount: 0, provider: settingsSnapshot.provider, settingsSnapshot, manualConversationCount: 0, manualNewChatRequired: true, dryRunLimit: message.dryRunLimit, dryRunCount: 0, target: message.target, mode: message.mode, status: "preparing",
        startedAt: now, updatedAt: now, page: 1, currentQuestion: 0, totalOnPage: 0,
        processedQuestionIds: [], startAnchorUsed: false, memorySourceQuizKey: requestedMemoryKeys[0] ?? null,
        memorySourceQuizKeys: requestedMemoryKeys,
        reviewEveryAnswer: isPracticeBatch ? false : message.target.assessmentKind !== "practice" || message.reviewEveryAnswer,
        knowledgeMaterialIds: requestedMaterialIds,
        practiceBatch: batchTargets ? { targets: batchTargets, currentIndex: 0 } : undefined,
        practiceAutomation,
        message: requestedMemoryKeys.length ? "Đang mở bài với các phần đáp án đã chọn..." : "Đang mở bài; câu chưa biết sẽ dùng AI đã chọn..."
      };
      await saveRun(run);
      await appendLog("info", `Bắt đầu ${message.target.name} (${message.target.assessmentKind}).`);
      const stayOnCurrentAttempt = message.mode === "from_current";
      if (tab.url !== message.target.url && !stayOnCurrentAttempt) await browser.tabs.update(tab.id!, { url: message.target.url });
      else await browser.tabs.sendMessage(tab.id!, { type: "RESUME_RUN" }).catch(() => undefined);
      return { ok: true, data: run };
    }
    case "STOP_RUN": {
      const stoppedRun = await mutateRun((run) => run ? {
        ...run,
        executionEpoch: crypto.randomUUID(),
        status: "paused",
        webUnknownRequestId: runUsesWeb(run) && ["dispatching", "in_flight"].includes(run.activeExecution?.status ?? "")
          ? run.activeExecution?.requestId
          : run.webUnknownRequestId,
        activeExecution: run.activeExecution && ["dispatching", "in_flight"].includes(run.activeExecution.status)
          ? { ...run.activeExecution, status: "unknown" }
          : run.activeExecution,
        message: "Đã dừng theo yêu cầu."
      } : undefined);
      activeRequests.forEach((controller) => controller.abort());
      activeRequests.clear();
      if (stoppedRun) await stopRequestCheckpoint(stoppedRun.id);
      await appendLog("warning", "Phiên chạy đã dừng.");
      await sendToActiveTab({ type: "STOP_RUN" }).catch(() => undefined);
      return { ok: true };
    }
    case "RESUME_RUN": {
      const run = await getRun();
      if (!run) throw new Error("Không có phiên chạy để tiếp tục.");
      if (!["paused", "error"].includes(run.status)) throw new Error("Chỉ có thể tiếp tục phiên đang dừng hoặc gặp lỗi.");
      if (run.usage?.pending.some((item) => item.status === "unknown")) throw new Error("Còn request chưa xác định usage; hãy đối soát trước khi tiếp tục.");
      if (run.webUnknownRequestId) throw new Error("AI Web có request chưa xác định kết quả. Kiểm tra tab AI và xác nhận trạng thái trước khi tiếp tục; không tự gửi lại.");
      const checkpoint = await getCheckpoint();
      if (checkpoint && checkpoint.phase !== "completed") throw new Error("Yêu cầu AI trước chưa rõ trạng thái. Hãy đối soát trước khi tiếp tục.");
      const settings = await getSettings();
      const webExecution = isWebProvider(settings.provider)
        ? await getRunnableWebAdapter(settings.provider, run.tnuTabId)
        : undefined;
      await validateProviderSelection(settings);
      const next = resumeWithSelection(run, settings, crypto.randomUUID());
      if (webExecution) {
        next.aiTabId = webExecution.binding.aiTabId;
        next.aiWindowId = webExecution.binding.aiWindowId;
        if (run.provider !== settings.provider || !run.conversationIdentity) {
          next.conversationIdentity = await createVerifiedConversation(webExecution.adapter);
          next.webCompletedCount = 0;
        } else if (run.conversationIdentity !== webExecution.conversationIdentity) {
          throw new Error("Cuộc trò chuyện AI đã thay đổi ngoài phiên. Hãy kiểm tra nội dung và tạo phiên mới để tránh gửi câu hỏi vào nhầm chat.");
        } else next.conversationIdentity = run.conversationIdentity;
        next.webFixture = webExecution.binding.fixture === true;
      } else {
        next.aiTabId = undefined;
        next.aiWindowId = undefined;
        next.conversationIdentity = undefined;
        next.webFixture = false;
        next.webCompletedCount = 0;
      }
      if (!next.pendingDecision) await clearCompletedCheckpoint(run.id);
      const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && canChangeSelection(current) ? next : undefined);
      if (!updated) throw new Error("Phiên đã thay đổi khi tiếp tục. Hãy thử lại.");
      try { await sendToActiveTab({ type: "RESUME_RUN" }); }
      catch (error) {
        await mutateRun((current) => current?.id === run.id && current.executionEpoch === next.executionEpoch ? { ...current, executionEpoch: crypto.randomUUID(), status: "paused", message: "Không thể kết nối lại tab TNU; phiên vẫn đang dừng." } : undefined);
        throw error;
      }
      return { ok: true };
    }
    case "RETRY_QUESTION": {
      const run = await getRun();
      if (!run || run.status !== "awaiting_user" || activeRequests.size) throw new Error("Hãy chờ hoặc dừng yêu cầu đang chạy trước khi thử lại.");
      if (run.webUnknownRequestId) throw new Error("Request AI Web chưa được đối soát. Kiểm tra tab AI rồi xác nhận không có phản hồi để mở chat mới.");
      if (run.usage?.pending.some((item) => item.status === "unknown")) throw new Error("Còn request chưa xác định usage; hãy đối soát trước khi thử lại.");
      const checkpoint = await getCheckpoint();
      if (checkpoint && checkpoint.phase !== "completed") throw new Error("Yêu cầu cũ chưa rõ trạng thái; hãy đối soát trước khi thử lại.");
      await clearCompletedCheckpoint(run.id);
      await updateRun({ executionEpoch: crypto.randomUUID(), activeExecution: undefined, status: "answering", error: undefined, pendingDecision: undefined, message: "Đang thử lại câu hiện tại..." });
      await sendToActiveTab({ type: "RETRY_QUESTION" });
      return { ok: true };
    }
    case "SKIP_QUESTION": {
      const run = await getRun();
      if (!run || run.status !== "awaiting_user" || !run.executionEpoch) throw new Error("Không có câu đang chờ để bỏ qua.");
      if (activeRequests.size) throw new Error("Hãy dừng hoặc chờ yêu cầu đang chạy trước khi bỏ qua.");
      await sendToActiveTab({ type: "SKIP_QUESTION", executionEpoch: run.executionEpoch });
      return { ok: true };
    }
    case "APPLY_SUGGESTION": {
      const run = await getRun();
      if (!run || run.status !== "awaiting_user" || !run.executionEpoch || !run.pendingDecision) throw new Error("Không có gợi ý đang chờ áp dụng.");
      const requestId = run.pendingDecision.decision.executionRequestId;
      if (requestId && (run.activeExecution?.requestId !== requestId || run.activeExecution.status !== "completed" || run.activeExecution.executionEpoch !== run.executionEpoch)) throw new Error("Kết quả AI không còn thuộc yêu cầu hiện tại.");
      if (run?.target.assessmentKind !== "practice" && !["agreed", "user_confirmed"].includes(run?.pendingDecision?.decision.verification?.status ?? "")) {
        throw new Error("Bài kiểm tra chỉ được áp dụng sau khi kiểm tra kép đồng thuận.");
      }
      await sendToActiveTab({ type: "APPLY_SUGGESTION", executionEpoch: run.executionEpoch });
      return { ok: true };
    }
    case "SUBMIT_PRACTICE": {
      const run = await getRun();
      if (!run || !run.executionEpoch || run.executionEpoch !== message.executionEpoch || run.status !== "awaiting_user" || run.target.assessmentKind !== "practice" || run.practiceAutomation?.submitPhase !== "ready") {
        throw new Error("Bài luyện tập không ở trạng thái sẵn sàng nộp.");
      }
      await sendToActiveTab({ type: "SUBMIT_PRACTICE", executionEpoch: run.executionEpoch });
      return { ok: true };
    }
    case "CONFIRM_VERIFICATION": {
      const run = await getRun();
      const pending = run?.pendingDecision;
      if (!run || run.status !== "awaiting_user" || !run.executionEpoch || !pending) throw new Error("Không có câu hỏi đang chờ xác nhận.");
      const decision = confirmVerificationChoice(pending.decision, message.choice);
      const allowed = new Set(pending.question.options.map((option) => option.id));
      if (decision.selectedOptionIds.some((id) => !allowed.has(id))) throw new Error("Phương án xác nhận không còn tồn tại trên câu hỏi.");
      const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.status === "awaiting_user" && current.pendingDecision?.question.id === pending.question.id && JSON.stringify(current.pendingDecision.decision) === JSON.stringify(pending.decision) ? { ...current, message: `${pending.question.number}: đã xác nhận thủ công, đang tiếp tục...`, pendingDecision: { question: pending.question, decision } } : undefined);
      if (!updated) throw new Error("Phiên đã đổi; xác nhận cũ bị bỏ qua.");
      await appendLog("warning", `${pending.question.number}: người dùng xác nhận thủ công ${message.choice === "primary" ? "gợi ý ban đầu" : "kết quả Gemini kiểm tra lại"}.`);
      await sendToActiveTab({ type: "APPLY_SUGGESTION", executionEpoch: run.executionEpoch });
      return { ok: true };
    }
    case "VERIFY_QUESTION": {
      const run = await getRun();
      const pending = run?.pendingDecision;
      if (!run || run.status !== "awaiting_user" || !run.executionEpoch || !pending) throw new Error("Không có câu hỏi đang chờ để kiểm tra lại.");
      const guard = { runId: run.id, executionEpoch: run.executionEpoch, requireActive: true };
      const previousPrimaryIds = pending.decision.verification?.primaryOptionIds ?? pending.decision.selectedOptionIds;
      if (!previousPrimaryIds.length) throw new Error("Câu này chưa có đáp án ban đầu để kiểm tra kép.");
      const memoryKeys = run.memorySourceQuizKeys ?? (run.memorySourceQuizKey ? [run.memorySourceQuizKey] : []);
      const cached = pending.decision.source === "memory" ? findMemoryDecision(await getAnswerMemory(), run.target, pending.question, memoryKeys) : undefined;
      const primary = cached ?? { ...pending.decision, selectedOptionIds: previousPrimaryIds, verification: undefined };
      const controller = new AbortController();
      const requestId = `${run.id}:${pending.question.id}:verify`;
      if (activeRequests.has(requestId)) throw new Error("Lượt kiểm tra này đang được xử lý.");
      activeRequests.set(requestId, controller);
      try {
        const settings = run.settingsSnapshot ?? await getSettings();
        let knowledgeChunks: KnowledgeChunk[] = [];
        if (run.knowledgeMaterialIds?.length) {
          const knowledgeIndex = await getKnowledgeIndex(run.target.courseId);
          if (knowledgeIndex) {
            const query = [pending.question.prompt, ...pending.question.options.map((option) => option.label)].join(" ");
            knowledgeChunks = searchSelectedKnowledge(knowledgeIndex.chunks, run.knowledgeMaterialIds, query, settings.documentLimit);
          }
        }
        const providerId = run.provider ?? settings.provider;
        const verificationId = crypto.randomUUID();
        const verificationExecution: NonNullable<RunSession["activeExecution"]> = { requestId: verificationId, executionEpoch: run.executionEpoch, questionId: pending.question.id, providerId, modelId: selectedProviderModel(settings, providerId), status: "waiting" };
        const reserved = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.status === "awaiting_user" && current.pendingDecision?.question.id === pending.question.id && JSON.stringify(current.pendingDecision.decision) === JSON.stringify(pending.decision) && !(current.activeExecution?.executionEpoch === run.executionEpoch && current.activeExecution?.status === "waiting") ? { ...current, activeExecution: verificationExecution } : undefined);
        if (!reserved) throw new Error("Lượt kiểm tra đã thay đổi hoặc đang có yêu cầu khác.");
        if (isWebProvider(providerId)) {
          const web = await getRunnableWebAdapter(providerId, run.tnuTabId);
          if (Boolean(run.webFixture) !== Boolean(web.binding.fixture) || run.aiTabId !== web.binding.aiTabId || run.aiWindowId !== web.binding.aiWindowId) throw new Error("Tab AI Web đã đổi; hãy bind lại trước khi kiểm tra độc lập.");
          const conversationIdentity = await createVerifiedConversation(web.adapter);
          const request = {
            sessionId: run.sessionId ?? run.id,
            requestId: verificationId,
            executionEpoch: run.executionEpoch,
            questionId: pending.question.id,
            providerId,
            conversationIdentity,
            prompt: buildWebRequestPrompt("Giải lại độc lập từ đầu. Không dựa vào đáp án hoặc suy luận trước đó.", pending.question, knowledgeChunks, verificationId),
            question: pending.question,
            timeoutMs: settings.webTimeoutMs,
            onDispatch: async () => {
              const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.status === "awaiting_user" && current.activeExecution?.requestId === verificationId && current.activeExecution.status === "waiting"
                ? { ...current, activeExecution: { ...current.activeExecution, status: "dispatching" }, message: `${pending.question.number}: đang gửi lượt kiểm tra độc lập tới AI Web.` }
                : undefined);
              if (!updated) throw new Error("Lượt kiểm tra đã dừng trước khi gửi.");
            },
            onInFlight: async () => {
              const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.status === "awaiting_user" && current.activeExecution?.requestId === verificationId && current.activeExecution.status === "dispatching"
                ? { ...current, activeExecution: { ...current.activeExecution, status: "in_flight" }, message: `${pending.question.number}: AI Web đang hoàn tất lượt kiểm tra độc lập.` }
                : undefined);
              if (!updated) throw new Error("Lượt kiểm tra đã dừng sau khi gửi.");
            }
          };
          try {
            const response = await executeWebRequest(web.adapter, request, controller.signal);
            const parsed = parseWebAnswer(response.content, pending.question, verificationId, settings.confidenceThreshold);
            const verifier = { ...parsed, source: "manual" as const, needsHumanReview: parsed.needsHumanReview };
            const decision = { ...reconcileIndependentCheck(primary, verifier, settings.confidenceThreshold), executionRequestId: verificationId };
            const statusMessage = decision.verification?.status === "agreed"
              ? `${pending.question.number}: kiểm tra kép đồng thuận, có thể áp dụng.`
              : `${pending.question.number}: kiểm tra kép chưa an toàn, đã khóa áp dụng tự động.`;
            const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.activeExecution?.requestId === verificationId && ["waiting", "dispatching", "in_flight"].includes(current.activeExecution.status) && current.status === "awaiting_user" && current.pendingDecision?.question.id === pending.question.id && JSON.stringify(current.pendingDecision.decision) === JSON.stringify(pending.decision)
              ? { ...current, aiTabId: web.binding.aiTabId, aiWindowId: web.binding.aiWindowId, conversationIdentity, webCompletedCount: 0, activeExecution: { ...current.activeExecution, status: "completed" }, message: statusMessage, pendingDecision: { question: pending.question, decision } }
              : undefined);
            if (!updated) throw new Error("Phiên đã đổi; kết quả kiểm tra cũ bị bỏ qua.");
            await sendToActiveTab({ type: "SHOW_VERIFICATION", executionEpoch: run.executionEpoch, questionId: pending.question.id, selectedOptionIds: decision.selectedOptionIds }).catch(() => undefined);
            await appendLog(decision.verification?.status === "agreed" ? "success" : "warning", statusMessage);
            return { ok: true, data: decision };
          } catch (error) {
            if (error instanceof UnknownWebOutcomeError) await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === verificationId
              ? { ...current, webUnknownRequestId: verificationId, activeExecution: { ...current.activeExecution, status: "unknown" }, message: "Lượt AI Web kiểm tra độc lập chưa xác định. Không gửi lại tự động." }
              : undefined);
            throw error;
          }
        }
        if (getProvider(run.provider ?? settings.provider).mode === "manual") {
          const manualRequestId = verificationId;
          const manualDecision = {
            ...primary, executionRequestId: verificationId, manualPrimary: primary, manualRequestId, manualRequiresNewChat: true,
            manualPrompt: buildManualPrompt("Hãy kiểm tra độc lập và giải lại câu hỏi. Không giả định đáp án nào đã được chọn.", pending.question, knowledgeChunks, manualRequestId)
          };
          const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.activeExecution?.requestId === verificationId && current.status === "awaiting_user" && current.pendingDecision?.question.id === pending.question.id && JSON.stringify(current.pendingDecision.decision) === JSON.stringify(pending.decision) ? { ...current, pendingDecision: { question: pending.question, decision: manualDecision }, message: `${pending.question.number}: tạo chat mới để kiểm tra độc lập.` } : undefined);
          if (!updated) throw new Error("Phiên đã đổi; lượt kiểm tra cũ bị bỏ qua.");
          return { ok: true, data: manualDecision };
        }
        if (!await updateRun({ message: `${pending.question.number}: AI đang phân tích độc lập để kiểm tra kép...` }, guard)) throw new Error("Phiên đã đổi; lượt kiểm tra cũ bị bỏ qua.");
        const apiKey = providerId === "gemini_api" ? await getApiKey() : await getProviderKey(providerId as ExternalApiProvider);
        const model = selectedProviderModel(settings, providerId);
        if (!apiKey || !model) throw new Error("Chưa cấu hình API key hoặc model cho AI đã chọn.");
        const checkpoint = await beginCheckpoint(run.id, `${pending.question.id}:verify`, { requestId: verificationId, executionEpoch: run.executionEpoch, providerId, modelId: model });
        let verifier;
        try {
          await ensureExecution(run.id, run.executionEpoch);
          const hooks = runRequestHooks(run.id, run.executionEpoch, verificationId, pending.question, knowledgeChunks, [], true);
          verifier = (await requestApiWithFallback({ runId: run.id, epoch: run.executionEpoch, requestId: verificationId, provider: providerId as ApiProviderId, settings, question: pending.question, knowledgeChunks, cacheEvidence: [], independent: true, controller, hooks })).decision;
          const latest = await getRun();
          if (controller.signal.aborted || !isCurrentExecution(latest, run.id, run.executionEpoch) || latest?.status !== "awaiting_user" || latest.pendingDecision?.question.id !== pending.question.id) throw new Error("Câu đang chờ đã thay đổi hoặc phiên đã dừng.");
        } catch (error) {
          await settleCheckpointFailure(run.id, checkpoint.requestId, error);
          throw error;
        }
        const decision = { ...reconcileIndependentCheck(primary, verifier, settings.confidenceThreshold), executionRequestId: verificationId };
        const statusMessage = decision.verification?.status === "agreed"
          ? `${pending.question.number}: kiểm tra kép đồng thuận, có thể áp dụng.`
          : `${pending.question.number}: kiểm tra kép chưa an toàn, đã khóa áp dụng tự động.`;
        const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.activeExecution?.requestId === verificationId && current.activeExecution.status === "waiting" && current.status === "awaiting_user" && current.pendingDecision?.question.id === pending.question.id && JSON.stringify(current.pendingDecision.decision) === JSON.stringify(pending.decision) ? { ...current, activeExecution: { ...current.activeExecution, status: "completed" }, message: statusMessage, pendingDecision: { question: pending.question, decision } } : undefined);
        if (!updated) throw new Error("Phiên đã đổi; kết quả kiểm tra cũ bị bỏ qua.");
        await sendToActiveTab({ type: "SHOW_VERIFICATION", executionEpoch: run.executionEpoch, questionId: pending.question.id, selectedOptionIds: decision.selectedOptionIds }).catch(() => undefined);
        await appendLog(decision.verification?.status === "agreed" ? "success" : "warning", statusMessage);
        return { ok: true, data: decision };
      } finally {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      }
    }
    case "SUBMIT_MANUAL_RESPONSE": {
      if (manualSubmissions.has(message.requestId)) throw new Error("Phản hồi này đang được kiểm tra.");
      manualSubmissions.add(message.requestId);
      try {
      const run = await getRun();
      const pending = run?.pendingDecision;
      if (!run || !run.executionEpoch || run.id !== message.runId || run.status !== "awaiting_user" || !pending || pending.question.id !== message.questionId || !pending.decision.manualRequestId || pending.decision.manualRequestId !== message.requestId) throw new Error("Yêu cầu thủ công không còn hiệu lực. Hãy kiểm tra lại câu đang chờ.");
      if (pending.question.images.length && !message.imagesAttached) throw new Error("Hãy xác nhận đã gửi đầy đủ ảnh câu hỏi cho AI.");
      if (pending.decision.manualRequiresNewChat && !message.newChatConfirmed) throw new Error("Hãy tạo chat mới và xác nhận trước khi gửi yêu cầu này.");
      const settings = run.settingsSnapshot ?? await getSettings();
      const parsed = parseManualResponse(message.response, pending.question, settings.confidenceThreshold, message.requestId);
      const decision = { ...(pending.decision.manualPrimary ? reconcileIndependentCheck(pending.decision.manualPrimary, parsed, settings.confidenceThreshold) : parsed), executionRequestId: message.requestId };
      const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && current.activeExecution?.requestId === message.requestId && current.activeExecution.status === "waiting" && current.status === "awaiting_user" && current.pendingDecision?.decision.manualRequestId === message.requestId ? { ...current, activeExecution: { ...current.activeExecution, status: "completed" }, manualConversationCount: recordManualReply(current.manualConversationCount ?? 0, Boolean(pending.decision.manualRequiresNewChat)), manualNewChatRequired: false, pendingDecision: { question: pending.question, decision }, error: undefined, message: `${pending.question.number}: đã nhận gợi ý AI Web; hãy kiểm tra trước khi áp dụng.` } : undefined);
      if (!updated) throw new Error("Phiên đã đổi; phản hồi cũ bị bỏ qua.");
      return { ok: true, data: decision };
      } finally { manualSubmissions.delete(message.requestId); }
    }
    case "MANUAL_NEW_CHAT": {
      const run = await getRun();
      if (!run || run.id !== message.runId || !run.executionEpoch || run.pendingDecision?.decision.manualRequestId) throw new Error("Không thể đặt lại bộ đếm khi đang chờ một yêu cầu AI Web.");
      const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && !current.pendingDecision?.decision.manualRequestId ? { ...current, manualConversationCount: 0, manualNewChatRequired: false } : undefined);
      if (!updated) throw new Error("Phiên đã đổi; không đặt lại bộ đếm cũ.");
      return { ok: true };
    }
    case "CREATE_WEB_CONVERSATION": {
      const run = await getRun();
      if (!run || run.id !== message.runId || !run.tnuTabId || !runUsesWeb(run) || run.webUnknownRequestId || activeRequests.size) throw new Error("Tạo chat mới chỉ khả dụng cho phiên AI Web đã dừng và không có request chưa rõ.");
      const provider = run.provider ?? run.settingsSnapshot?.provider;
      if (!provider || !isWebProvider(provider)) throw new Error("Provider của phiên không phải AI Web.");
      const web = await getRunnableWebAdapter(provider, run.tnuTabId);
      const conversationIdentity = await createVerifiedConversation(web.adapter);
      const updated = await mutateRun((current) => current?.id === run.id && current.executionEpoch === run.executionEpoch && !current.webUnknownRequestId && !["dispatching", "in_flight"].includes(current.activeExecution?.status ?? "")
        ? { ...current, aiTabId: web.binding.aiTabId, aiWindowId: web.binding.aiWindowId, conversationIdentity, webCompletedCount: 0, message: "Đã xác minh chat mới cho các câu tiếp theo." }
        : undefined);
      if (!updated) throw new Error("Phiên đã thay đổi; không thể gắn chat mới.");
      return { ok: true };
    }
    case "RESOLVE_UNKNOWN_WEB": {
      const run = await getRun();
      if (!run || run.webUnknownRequestId !== message.requestId) throw new Error("Không tìm thấy request AI Web đang chờ xác nhận.");
      if (activeRequests.size) throw new Error("Đang dừng request. Hãy chờ nó kết thúc trước khi đối soát.");
      const selected = await getSettings();
      const web = isWebProvider(selected.provider) ? await getRunnableWebAdapter(selected.provider, run.tnuTabId) : undefined;
      const conversationIdentity = web ? await createVerifiedConversation(web.adapter) : undefined;
      const updated = await mutateRun((current) => current?.id === run.id && current.webUnknownRequestId === message.requestId
        ? { ...current, executionEpoch: crypto.randomUUID(), activeExecution: undefined, pendingDecision: undefined, webUnknownRequestId: undefined, aiTabId: web?.binding.aiTabId, aiWindowId: web?.binding.aiWindowId, conversationIdentity, webFixture: web?.binding.fixture ?? false, webCompletedCount: 0, status: "paused", message: web ? "Đã tạo chat mới sau khi bạn xác nhận request cũ không có câu trả lời. Hãy Resume để tiếp tục câu hiện tại." : "Đã xác nhận request AI Web cũ không có phản hồi. Hãy Resume để tiếp tục câu hiện tại bằng provider API đã chọn." }
        : undefined);
      if (!updated) throw new Error("Phiên đã đổi; chưa đối soát được request AI Web.");
      await appendLog("warning", `Đã đối soát request AI Web ${message.requestId} theo xác nhận không có phản hồi${web ? "; tạo chat mới để tránh trùng kết quả muộn." : "."}`);
      return { ok: true };
    }
    case "CLEAR_REQUEST_CHECKPOINT":
      if (activeRequests.size) throw new Error("Yêu cầu vẫn đang chạy. Hãy dừng phiên trước khi xác nhận xử lý yêu cầu cũ.");
      {
        const checkpoint = await getCheckpoint();
        const run = await getRun();
        if (checkpoint?.phase === "unknown_delivery" || run?.usage?.pending.some((item) => item.status === "unknown" && item.requestId === checkpoint?.requestId)) {
          throw new Error("Không thể xóa checkpoint khi usage chưa rõ. Hãy đối soát từng request ở mục Ngân sách phiên.");
        }
        if (checkpoint?.phase === "reserved" && checkpoint.reservationId && run?.usage) {
          await mutateRun((current) => current?.id === run.id && current.usage ? { ...current, usage: releaseUnsentReservation(current.usage, checkpoint.reservationId!) } : undefined);
        }
      }
      await clearCheckpoint();
      await appendLog("warning", "Người dùng đã xác nhận đối soát yêu cầu AI cũ trước khi thử lại.");
      return { ok: true };
    case "RESOLVE_UNKNOWN_USAGE": {
      if (activeRequests.size) throw new Error("Yêu cầu còn đang chạy; hãy dừng phiên trước khi đối soát.");
      const run = await getRun();
      const pending = run?.usage?.pending.find((item) => item.requestId === message.requestId && item.status === "unknown");
      if (!run || !pending) throw new Error("Không tìm thấy request có usage chưa rõ.");
      const checkpoint = await getCheckpoint();
      if (checkpoint?.requestId === message.requestId && !["unknown_delivery", "completed"].includes(checkpoint.phase)) throw new Error("Request chưa ở trạng thái có thể đối soát.");
      const updated = await mutateRun((current) => {
        if (current?.id !== run.id || !current.usage) return undefined;
        const usage = resolveUnknownReservation(current.usage, message.requestId, message.resolution);
        const shouldSkip = message.resolution === "count_estimate" && !current.pendingDecision && Boolean(pending.questionId);
        const nextEpoch = current.pendingDecision ? current.executionEpoch : crypto.randomUUID();
        return {
          ...current, usage,
          executionEpoch: nextEpoch,
          status: current.pendingDecision ? current.status : "paused",
          activeExecution: current.pendingDecision ? current.activeExecution : undefined,
          processedQuestionIds: shouldSkip ? [...new Set([...current.processedQuestionIds, pending.questionId!])] : current.processedQuestionIds,
          message: message.resolution === "not_charged"
            ? "Đã xác nhận request không bị tính usage; bạn có thể tiếp tục thủ công."
            : "Đã đưa dự toán bảo thủ vào ngân sách và khóa gửi lại câu này tự động."
        };
      });
      if (!updated) throw new Error("Phiên đã thay đổi trong lúc đối soát usage.");
      if (checkpoint?.requestId === message.requestId && ["unknown_delivery", "completed"].includes(checkpoint.phase)) await clearCheckpoint();
      await appendLog("warning", message.resolution === "not_charged" ? `Đối soát ${message.requestId}: người dùng xác nhận không bị tính usage.` : `Đối soát ${message.requestId}: tính dự toán bảo thủ vào ngân sách.`);
      return { ok: true };
    }
    case "ANSWER_QUESTION": {
      const run = await getRun();
      if (!run || !isCurrentExecution(run, message.runId, message.executionEpoch)) throw new Error("Phiên chạy không còn hoạt động.");
      const memoryKeys = run.memorySourceQuizKeys ?? (run.memorySourceQuizKey ? [run.memorySourceQuizKey] : []);
      const settings = run.settingsSnapshot ?? await getSettings();
      const recoveredWebResponse = run.webCompletedResponse;
      if (recoveredWebResponse && run.provider === settings.provider && sameQuestionSnapshot(recoveredWebResponse.question, message.question)
        && run.activeExecution?.status === "completed" && recoveredWebResponse.decision.executionRequestId === run.activeExecution.requestId
        && run.activeExecution.executionEpoch === message.executionEpoch) {
        return { ok: true, data: recoveredWebResponse.decision };
      }
      const execution = await reserveAnswer(run, message.question.id, message.executionEpoch, settings);
      const memory = await getAnswerMemory();
      const remembered = settings.cacheMode === "priority" ? findMemoryDecision(memory, run.target, message.question, memoryKeys) : undefined;
      if (remembered) {
        await ensureExecution(run.id, message.executionEpoch);
        await appendLog("success", `Tìm thấy đáp án đã chấm đúng cho ${message.question.number}.`);
        await completeExecution(run.id, message.executionEpoch, execution.requestId);
        return { ok: true, data: { ...remembered, executionRequestId: execution.requestId } };
      }
      const guard = { runId: run.id, executionEpoch: message.executionEpoch, requireActive: true };
      if (!await updateRun({ message: `${message.question.number}: không có đáp án đã lưu phù hợp, đang chuẩn bị hỏi AI...` }, guard)) throw new Error("Phiên đã đổi; yêu cầu cũ bị bỏ qua.");
      const controller = new AbortController();
      const requestId = `${run.id}:${message.question.id}`;
      if (activeRequests.has(requestId)) throw new Error("Câu hỏi này đang được xử lý.");
      activeRequests.set(requestId, controller);
      try {
        const cacheEvidence = settings.cacheMode === "ai" ? selectedMemoryEvidence(memory, run.target, message.question, memoryKeys) : [];
        let knowledgeChunks: KnowledgeChunk[] = [];
        if (run.knowledgeMaterialIds?.length) {
          const knowledgeIndex = await getKnowledgeIndex(run.target.courseId);
          if (knowledgeIndex) {
            const query = [message.question.prompt, ...message.question.options.map((option) => option.label)].join(" ");
            knowledgeChunks = searchSelectedKnowledge(knowledgeIndex.chunks, run.knowledgeMaterialIds, query, settings.documentLimit);
          }
        }
        if (isWebProvider(execution.providerId)) {
          const web = await getRunnableWebAdapter(execution.providerId, run.tnuTabId);
          if (run.aiTabId !== web.binding.aiTabId || run.aiWindowId !== web.binding.aiWindowId || Boolean(run.webFixture) !== Boolean(web.binding.fixture)) throw new Error("AI tab đã đổi sau khi bắt đầu phiên. Hãy dừng và bind lại trước khi tiếp tục.");
          let conversationIdentity = run.conversationIdentity;
          if (!conversationIdentity || web.conversationIdentity !== conversationIdentity) {
            // A blank ChatGPT/Gemini conversation can change its SPA URL between
            // session creation and the first dispatch. No request has left the
            // browser while the execution is still waiting, so it is safe to
            // adopt the freshly verified identity instead of failing the run.
            conversationIdentity = web.conversationIdentity;
            const synchronized = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch)
              && current?.activeExecution?.requestId === execution.requestId
              && current.activeExecution.status === "waiting"
              ? { ...current, conversationIdentity, message: "Đã đồng bộ cuộc trò chuyện AI trước khi gửi." }
              : undefined);
            if (!synchronized) throw new Error("Conversation AI thay đổi khi request đang chạy; câu hỏi chưa được gửi.");
          }
          const previousCount = run.webCompletedCount ?? 0;
          const startNewConversation = shouldStartManualChat(previousCount, settings.manualRotationEvery, false);
          if (startNewConversation) {
            conversationIdentity = await createVerifiedConversation(web.adapter);
            const rotated = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch) && current?.activeExecution?.requestId === execution.requestId
              ? { ...current, conversationIdentity, webCompletedCount: 0, message: "Đã xác minh cuộc trò chuyện AI mới." }
              : undefined);
            if (!rotated) throw new Error("Phiên đã đổi khi tạo cuộc trò chuyện mới.");
          }
          let webRetry = 0;
          const maxWebRetries = run.practiceAutomation?.enabled ? run.practiceAutomation.webRetryCount : 0;
          while (true) {
            const request = {
              sessionId: run.sessionId ?? run.id,
              requestId: execution.requestId,
              executionEpoch: message.executionEpoch,
              questionId: message.question.id,
              providerId: execution.providerId,
              conversationIdentity,
              prompt: buildWebRequestPrompt(settings.manualPrompt, message.question, knowledgeChunks, execution.requestId, cacheEvidence),
              question: message.question,
              timeoutMs: settings.webTimeoutMs,
              onDispatch: async () => {
                const updated = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch) && current?.activeExecution?.requestId === execution.requestId && current.activeExecution.status === "waiting"
                  ? { ...current, activeExecution: { ...current.activeExecution, status: "dispatching" }, message: `${message.question.number}: đang gửi nội dung tới ${web.binding.fixture ? "local AI fixture" : "tab AI Web"}${webRetry ? ` (retry ${webRetry}/${maxWebRetries})` : ""}...` }
                  : undefined);
                if (!updated) throw new Error("Phiên đã dừng trước khi gửi request.");
              },
              onInFlight: async () => {
                const updated = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch) && current?.activeExecution?.requestId === execution.requestId && current.activeExecution.status === "dispatching"
                  ? { ...current, activeExecution: { ...current.activeExecution, status: "in_flight" }, message: `${message.question.number}: ${web.binding.fixture ? "local AI fixture" : "AI Web"} đang trả lời...` }
                  : undefined);
                if (!updated) throw new Error("Phiên đã dừng sau khi gửi request.");
              }
            };
            try {
              let response;
              try {
                response = await executeWebRequest(web.adapter, request, controller.signal);
              } catch (error) {
                if (!(error instanceof UnknownWebOutcomeError) || webRetry >= maxWebRetries || controller.signal.aborted) throw error;
                await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === execution.requestId
                  ? { ...current, message: `${message.question.number}: đang đối soát phản hồi AI Web trước khi retry...` }
                  : undefined);
                response = await web.adapter.recoverResponse?.(request, 15_000).catch(() => undefined);
                if (!response) {
                  webRetry += 1;
                  try { conversationIdentity = await createVerifiedConversation(web.adapter); }
                  catch { throw new UnknownWebOutcomeError("Không đối soát được phản hồi cũ hoặc tạo chat mới; request vẫn chưa xác định kết quả.", execution.requestId); }
                  const retryReady = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch) && current?.activeExecution?.requestId === execution.requestId
                    ? { ...current, conversationIdentity, webUnknownRequestId: undefined, activeExecution: { ...current.activeExecution, status: "waiting" }, message: `${message.question.number}: không có phản hồi dùng được; chuẩn bị retry ${webRetry}/${maxWebRetries} trong chat mới.` }
                    : undefined);
                  if (!retryReady) throw new Error("Phiên đã đổi trước khi retry AI Web.");
                  continue;
                }
              }
              const parsed = parseWebAnswer(response.content, message.question, execution.requestId, settings.confidenceThreshold);
              const latest = await getRun();
              if (!isCurrentExecution(latest, run.id, message.executionEpoch) || controller.signal.aborted) throw new Error("Phiên đã dừng hoặc thay đổi; phản hồi cũ bị loại bỏ.");
              const decision = { ...parsed, source: "manual" as const, executionRequestId: execution.requestId };
              const updated = await mutateRun((current) => isCurrentExecution(current, run.id, message.executionEpoch) && current?.activeExecution?.requestId === execution.requestId && ["in_flight", "dispatching", "waiting"].includes(current.activeExecution.status)
                ? { ...current, conversationIdentity, webUnknownRequestId: undefined, webCompletedCount: startNewConversation || webRetry ? 1 : previousCount + 1, webCompletedResponse: { question: message.question, decision }, activeExecution: { ...current.activeExecution, status: "completed" }, message: `${message.question.number}: đã nhận phản hồi hoàn chỉnh từ ${web.binding.fixture ? "local AI fixture" : "AI Web"}${webRetry ? ` sau ${webRetry} lần retry` : ""}.` }
                : undefined);
              if (!updated) throw new Error("Phiên đã đổi; phản hồi cũ không được dùng.");
              return { ok: true, data: decision };
            } catch (error) {
              if (error instanceof UnknownWebOutcomeError) {
                await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === execution.requestId
                  ? { ...current, webUnknownRequestId: execution.requestId, activeExecution: { ...current.activeExecution, status: "unknown" }, status: "paused", message: maxWebRetries ? `Đã hết ${maxWebRetries} lần retry AI Web nhưng kết quả vẫn chưa xác định. Kiểm tra tab AI trước.` : "AI Web đã nhận request nhưng chưa thể xác nhận kết quả. Không tự gửi lại; kiểm tra tab AI trước." }
                  : undefined);
              } else if (error instanceof ConfirmedWebCancellationError) {
                await mutateRun((current) => current?.id === run.id && current.activeExecution?.requestId === execution.requestId
                  ? { ...current, webUnknownRequestId: undefined, activeExecution: undefined, status: "paused", message: "Fixture xác nhận generation đã dừng trước khi hoàn tất. Câu hiện tại chưa được trả lời và có thể tiếp tục." }
                  : undefined);
              }
              throw error;
            }
          }
        }
        if (getProvider(run.provider ?? settings.provider).mode === "manual") {
          await ensureExecution(run.id, message.executionEpoch);
          const manualRequestId = execution.requestId;
          return { ok: true, data: {
            selectedOptionIds: [], confidence: 0, reason: "Hãy gửi nội dung và ảnh (nếu có) sang AI Web, sau đó dán phản hồi JSON vào đây.", needsHumanReview: true,
            source: "manual", manualRequestId, executionRequestId: execution.requestId, manualRequiresNewChat: shouldStartManualChat(run.manualConversationCount ?? 0, settings.manualRotationEvery, Boolean(run.manualNewChatRequired)), manualPrompt: buildManualPrompt(settings.manualPrompt, message.question, knowledgeChunks, manualRequestId, cacheEvidence)
          } };
        }
        const providerId = execution.providerId;
        const apiKey = providerId === "gemini_api" ? await getApiKey() : await getProviderKey(providerId as ExternalApiProvider);
        const model = execution.modelId;
        if (!apiKey || !model) throw new Error("Chưa cấu hình API key hoặc model cho AI đã chọn.");
        let checkpoint = await beginCheckpoint(run.id, message.question.id, { requestId: execution.requestId, executionEpoch: message.executionEpoch, providerId, modelId: model });
        let currentRequestId = checkpoint.requestId;
        try {
          await ensureExecution(run.id, message.executionEpoch);
          const hooks = runRequestHooks(run.id, message.executionEpoch, currentRequestId, message.question, knowledgeChunks, cacheEvidence, false);
          let result = await requestApiWithFallback({ runId: run.id, epoch: message.executionEpoch, requestId: execution.requestId, provider: providerId as ApiProviderId, settings, question: message.question, knowledgeChunks, cacheEvidence, independent: false, controller, hooks });
          let decision = result.decision;
          if (settings.uncertainMode === "reason" && (decision.needsHumanReview || decision.confidence < settings.confidenceThreshold)) {
            if (!await updateRun({ message: `${message.question.number}: AI đang tự suy luận lại...` }, guard)) throw new Error("Phiên đã đổi; yêu cầu cũ bị bỏ qua.");
            currentRequestId = `${execution.requestId}:reasoning:${crypto.randomUUID()}`;
            checkpoint = await beginCheckpoint(run.id, `${message.question.id}:reasoning`, { requestId: currentRequestId, executionEpoch: message.executionEpoch, providerId: result.provider, modelId: result.model });
            const reasoningHooks = runRequestHooks(run.id, message.executionEpoch, currentRequestId, message.question, knowledgeChunks, [], true);
            result = await requestApiWithFallback({ runId: run.id, epoch: message.executionEpoch, requestId: currentRequestId, provider: result.provider, settings, question: message.question, knowledgeChunks, cacheEvidence: [], independent: true, controller, hooks: reasoningHooks });
            decision = result.decision;
          }
          const latest = await getRun();
          if (!isCurrentExecution(latest, run.id, message.executionEpoch) || controller.signal.aborted) throw new Error("Phiên đã dừng hoặc thay đổi.");
          await ensureExecution(run.id, message.executionEpoch);
          await completeExecution(run.id, message.executionEpoch, execution.requestId);
          return { ok: true, data: { ...decision, executionRequestId: execution.requestId } };
        } catch (error) {
          await settleCheckpointFailure(run.id, currentRequestId, error);
          throw error;
        }
      } finally {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      }
    }
    case "SAVE_REVIEW_ANSWERS": {
      const run = await getRun();
      if (!sender.url || !isReviewForTarget(sender.url, message.target.url)) throw new Error("Trang xem lại không khớp bài học; không lưu cache.");
      const expectedQuizKey = quizKey(message.target);
      if (message.entries.some((entry) => entry.quizKey !== expectedQuizKey || entry.courseId !== message.target.courseId)) throw new Error("Dữ liệu cache không khớp bài đang xem lại.");
      const matchingRun = run && run.id === message.runId && run.executionEpoch === message.executionEpoch && isReviewForTarget(sender.url, run.target.url) ? run : undefined;
      const sourceUrl = sender.url;
      const alreadyCaptured = Boolean(sourceUrl && await wasReviewCaptured(sourceUrl));
      // Memory merge is idempotent. Retry every non-empty review payload so a
      // premature zero-result capture cannot permanently block this page.
      const shouldSave = message.entries.length > 0;
      const total = shouldSave ? await saveAnswerMemory(message.entries) : (await getAnswerMemory()).length;
      const hasReviewOutcome = shouldSave || Boolean(message.score);
      if (sourceUrl && hasReviewOutcome && !alreadyCaptured) await markReviewCaptured(sourceUrl);
      if (shouldSave) await appendLog("success", `Đã học ${message.entries.length} đáp án đúng từ trang xem lại.`);
      else if (!message.entries.length && !alreadyCaptured) await appendLog("warning", "Trang xem lại hiện tại không có đáp án đúng có thể lưu.");
      let nextTarget;
      let navigationEpoch: string | undefined;
      let batchCompleted = false;
      let retryingPractice = false;
      // A non-perfect score without any learned answer is not enough evidence
      // for another automatic attempt: pause instead of creating a blind loop.
      const transitionScore = message.score && (message.score.full || shouldSave) ? message.score : undefined;
      const automationTransition = matchingRun?.practiceAutomation && message.reviewComplete && !alreadyCaptured
        ? practiceReviewTransition(matchingRun.practiceAutomation, transitionScore)
        : undefined;
      if (matchingRun?.practiceAutomation && automationTransition) {
        if (automationTransition.outcome === "retry" && automationTransition.next) {
          const learnedKeys = [...new Set([...(matchingRun.memorySourceQuizKeys ?? []), quizKey(matchingRun.target)])];
          const nextRun = resetRunForPracticeAttempt({ ...matchingRun, memorySourceQuizKey: learnedKeys[0] ?? null, memorySourceQuizKeys: learnedKeys }, automationTransition.next);
          await saveRun(nextRun);
          navigationEpoch = nextRun.executionEpoch;
          nextTarget = matchingRun.target;
          retryingPractice = true;
        } else if (automationTransition.outcome === "score_missing") {
          await updateRun({ status: "paused", message: "Không đọc được điểm từ trang xem lại; đã dừng để tránh nộp lặp." });
        } else if (automationTransition.outcome === "limit") {
          await updateRun({ status: "paused", practiceAutomation: automationTransition.next, message: `Đã hết ${matchingRun.practiceAutomation.maxAttempts} lần làm nhưng chưa đạt điểm tối đa.` });
        } else if (automationTransition.outcome === "complete" && automationTransition.next) {
          const scoreLabel = automationTransition.next.scoreHistory.at(-1)?.label ?? "điểm tối đa";
          if (matchingRun.practiceBatch) {
            const batchStep = practiceBatchReviewStep(matchingRun, true);
            nextTarget = batchStep?.nextTarget;
            if (nextTarget) {
              const learnedKeys = [...new Set([...(matchingRun.memorySourceQuizKeys ?? []), quizKey(matchingRun.target)])];
              const nextRun = {
                ...resetRunForPracticeAttempt({ ...matchingRun, target: nextTarget, memorySourceQuizKey: learnedKeys[0] ?? null, memorySourceQuizKeys: learnedKeys }, { ...matchingRun.practiceAutomation, attemptNumber: 1, scoreHistory: [], submitPhase: "idle" }),
                practiceBatch: { ...matchingRun.practiceBatch, currentIndex: batchStep!.nextIndex },
                message: `${matchingRun.target.name} đã đạt ${scoreLabel}. Đang chuyển sang ${nextTarget.name}...`
              };
              await saveRun(nextRun);
              navigationEpoch = nextRun.executionEpoch;
            } else {
              batchCompleted = true;
              await updateRun({ status: "completed", practiceAutomation: automationTransition.next, message: `Đã hoàn tất chuỗi luyện tập; bài cuối đạt ${scoreLabel}.` });
            }
          } else {
            await updateRun({ status: "completed", practiceAutomation: automationTransition.next, message: `Đã đạt điểm tối đa ${scoreLabel} sau ${matchingRun.practiceAutomation.attemptNumber} lần làm.` });
          }
        }
      } else {
        const batchStep = matchingRun ? practiceBatchReviewStep(matchingRun, message.reviewComplete && !alreadyCaptured) : undefined;
        if (matchingRun?.practiceBatch && batchStep) {
        nextTarget = batchStep.nextTarget;
        const learnedKeys = [...new Set([...(matchingRun.memorySourceQuizKeys ?? []), quizKey(matchingRun.target)])];
        if (nextTarget) {
          await saveRun({
            ...matchingRun, target: nextTarget, status: "preparing", page: 1, currentQuestion: 0, totalOnPage: 0,
            manualConversationCount: 0, manualNewChatRequired: true,
            activeExecution: undefined, processedQuestionIds: [], startAnchorUsed: false, startAnchorPage: undefined, startAnchorIndex: undefined, pendingDecision: undefined, currentQuestionSnapshot: undefined,
            memorySourceQuizKey: learnedKeys[0] ?? null, memorySourceQuizKeys: learnedKeys,
            practiceBatch: { ...matchingRun.practiceBatch, currentIndex: batchStep.nextIndex },
            message: `Đã ghi nhớ ${matchingRun.target.name}. Đang chuyển sang ${nextTarget.name}...`, updatedAt: new Date().toISOString()
          });
        } else {
          batchCompleted = batchStep.batchCompleted;
          await updateRun({ status: "completed", message: `Đã hoàn tất chuỗi ${matchingRun.practiceBatch.targets.length} bài luyện tập và lưu các đáp án đúng đọc được.` });
        }
        } else if (matchingRun) {
        await updateRun({ message: shouldSave
          ? `Đã lưu ${message.entries.length} đáp án đúng từ trang xem lại vào cache.`
          : "Chưa đọc được đáp án đúng trên trang xem lại; extension sẽ thử lại khi trang được tải lại." });
        }
      }
      return { ok: true, data: { saved: shouldSave ? message.entries.length : 0, total, nextTarget, batchCompleted, retryingPractice, navigationEpoch } };
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
    case "INDEX_COURSE_MATERIALS": {
      const state = await getState();
      const course = state.courseIndex?.courses.find((item) => item.id === message.courseId);
      if (!course) throw new Error("Không tìm thấy khóa học. Hãy quét khóa học trước.");
      const materials = course.weeks.flatMap((week) => week.materials ?? []);
      if (!materials.length) throw new Error("Khóa học này chưa có slide hoặc giáo trình được nhận diện.");
      await appendLog("info", `Đang lập chỉ mục ${materials.length} tài liệu của ${course.name}.`);
      const tab = await activeTnuTab();
      const result = await browser.tabs.sendMessage(tab.id!, { type: "EXTRACT_COURSE_MATERIALS", materials }) as RuntimeResponse<KnowledgeExtractionResult>;
      if (!result.ok || !result.data) throw new Error(result.error || "Không đọc được tài liệu.");
      const index: KnowledgeIndex = {
        courseId: course.id, courseName: course.name, indexedAt: new Date().toISOString(), materials,
        chunks: result.data.chunks, failedMaterials: result.data.failedMaterials
      };
      await saveKnowledgeIndex(index);
      await appendLog("success", `Đã lập chỉ mục ${index.chunks.length} đoạn từ ${materials.length - index.failedMaterials.length}/${materials.length} tài liệu.`);
      return { ok: true, data: index };
    }
    case "SEARCH_KNOWLEDGE": {
      const query = message.query.trim();
      if (!query) throw new Error("Hãy nhập nội dung cần tìm.");
      const index = await getKnowledgeIndex(message.courseId);
      if (!index) throw new Error("Môn này chưa được lập chỉ mục tài liệu.");
      const matches = searchKnowledge(index.chunks, query, 8);
      if (!matches.length) return { ok: true, data: { answer: "Không tìm thấy đoạn tài liệu phù hợp với từ khóa này.", citations: [], usedGemini: false, insufficientEvidence: true } satisfies KnowledgeSearchResponse };
      if (!message.useGemini) {
        return { ok: true, data: {
          answer: `Tìm thấy ${matches.length} đoạn liên quan. Mở các nguồn bên dưới để xem nội dung đầy đủ.`,
          citations: matches.slice(0, 6).map(citationFromChunk), usedGemini: false, insufficientEvidence: false
        } satisfies KnowledgeSearchResponse };
      }
      const controller = new AbortController();
      const requestId = `knowledge:${message.courseId}`;
      activeRequests.get(requestId)?.abort();
      activeRequests.set(requestId, controller);
      try {
        const data = await answerKnowledgeWithGemini(await getApiKey(), await getSettings(), query, matches, controller.signal);
        return { ok: true, data };
      } finally {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      }
    }
    case "CLEAR_KNOWLEDGE_INDEX":
      await clearKnowledgeIndex(message.courseId);
      await appendLog("warning", "Đã xóa chỉ mục tài liệu của một khóa học.");
      return { ok: true };
    case "UPDATE_RUN": {
      if ("usage" in message.patch || "settingsSnapshot" in message.patch || "provider" in message.patch || "tnuTabId" in message.patch || "target" in message.patch) throw new Error("Không thể thay đổi cấu hình hoặc thống kê phiên bằng cập nhật trang.");
      const run = await getRun();
      if (!run || run.id !== message.runId) return { ok: true, data: run };
      if (sender.url?.startsWith("https://tnu.aum.edu.vn/") && (!message.executionEpoch || message.executionEpoch !== run.executionEpoch)) throw new Error("Phiên đã đổi; bỏ qua cập nhật cũ.");
      const guard = message.executionEpoch ? { runId: message.runId, executionEpoch: message.executionEpoch } : undefined;
      const updated = await updateRun(message.patch, guard);
      if (!updated) throw new Error("Phiên đã đổi; bỏ qua cập nhật cũ.");
      return { ok: true, data: updated };
    }
    case "NOTIFY":
      await notify(message.title, message.message, message.level);
      return { ok: true };
    case "CONTENT_READY":
      return { ok: true };
    default:
      return { ok: false, error: "Thông điệp không được hỗ trợ." };
  }
}

export function dispatchMessage(message: RuntimeMessage, sender: Browser.runtime.MessageSender): Promise<RuntimeResponse> {
  return storageAccessReady.then(() => {
    const control = ["SAVE_SETTINGS", "BEGIN_CREDENTIAL_CHANGE", "COMPLETE_CREDENTIAL_CHANGE", "CANCEL_CREDENTIAL_CHANGE", "SELECT_PROVIDER_MODEL", "TEST_API_CAPABILITY", "SWITCH_PROVIDER", "SELECT_GEMINI_MODEL", "START_RUN", "STOP_RUN", "RESUME_RUN", "RETRY_QUESTION", "SAVE_REVIEW_ANSWERS"].includes(message.type);
    const work = control ? controlQueue.then(() => handle(message, sender)) : handle(message, sender);
    if (control) controlQueue = work.catch(() => undefined);
    return work;
  });
}

export default defineBackground(() => {
  storageAccessReady = secureLocalStorage();
  void storageAccessReady.catch(() => undefined);
  browser.runtime.onInstalled.addListener(() => {
    void secureLocalStorage();
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
  browser.runtime.onStartup.addListener(() => void secureLocalStorage());
  browser.tabs.onRemoved?.addListener((tabId) => {
    void handleTnuTabLifecycleEvent(tabId, "closed").catch(() => undefined);
    void invalidateWebTabBinding(tabId, "closed").catch(() => undefined);
  });
  browser.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      void handleTnuTabLifecycleEvent(tabId, "reloaded").catch(() => undefined);
    }
    if (typeof changeInfo.url === "string") void handleWebTabUrlChange(tabId, changeInfo.url).catch(() => undefined);
  });
  browser.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
    dispatchMessage(message, sender)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RuntimeResponse));
    return true;
  });
});
