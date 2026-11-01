import type { AppSettings, ProviderId, RunSession } from "./types";

export function canChangeSelection(run: RunSession | undefined): boolean {
  return !run || ["idle", "paused", "completed", "error"].includes(run.status);
}

export function selectedModel(settings: AppSettings): string {
  return (settings.customModel || settings.model).replace(/^models\//, "").trim();
}

export function selectedProviderModel(settings: AppSettings, provider: ProviderId = settings.provider): string {
  if (provider === "gemini_api") return selectedModel(settings);
  if (provider === "openai_api") return (settings.openaiModel ?? "").trim();
  if (provider === "anthropic_api") return (settings.anthropicModel ?? "").trim();
  return "";
}

export function resumeWithSelection(run: RunSession, selected: AppSettings, epoch: string): RunSession {
  const prior = run.settingsSnapshot ?? selected;
  const previousProvider = run.provider ?? prior.provider;
  const changed = previousProvider !== selected.provider || prior.selectionRevision !== selected.selectionRevision || selectedProviderModel(prior, selected.provider) !== selectedProviderModel(selected, selected.provider) || (selected.provider === "openai_api" && Boolean(prior.openaiStructuredOutputs) !== Boolean(selected.openaiStructuredOutputs));
  const discardPending = changed || Boolean(run.pendingDecision?.decision.manualRequestId) || Boolean(run.pendingDecision && !run.pendingDecision.decision.selectedOptionIds.length && !run.pendingDecision.decision.verification);
  const pendingDecision = discardPending ? undefined : run.pendingDecision;
  const activeExecution = run.activeExecution;
  const retainCompletedWebResponse = !changed && Boolean(run.webCompletedResponse) && activeExecution?.status === "completed" && run.webCompletedResponse?.decision.executionRequestId === activeExecution.requestId;
  const retainPendingExecution = Boolean(pendingDecision && activeExecution?.status === "completed" && pendingDecision.decision.executionRequestId === activeExecution.requestId);
  const retainedExecution = activeExecution && (retainPendingExecution || retainCompletedWebResponse)
    ? { ...activeExecution, executionEpoch: epoch } : undefined;
  return {
    ...run, executionEpoch: epoch, activeExecution: retainedExecution, provider: selected.provider,
    startAnchorPage: run.mode === "from_current" && run.startAnchorUsed && run.startAnchorPage === undefined ? run.page : run.startAnchorPage,
    startAnchorIndex: run.mode === "from_current" && run.startAnchorUsed && run.startAnchorIndex === undefined ? Math.max(0, run.currentQuestion - 1) : run.startAnchorIndex,
    settingsSnapshot: { ...prior, apiPrompt: prior.apiPrompt ?? selected.apiPrompt, timeoutMs: selected.timeoutMs, webTimeoutMs: selected.webTimeoutMs, maxRequests: selected.maxRequests, maxTokens: selected.maxTokens, maxCostUsd: selected.maxCostUsd, modelPrices: selected.modelPrices, fallbackEnabled: selected.fallbackEnabled, fallbackOrder: selected.fallbackOrder, fallbackMax: selected.fallbackMax, openaiStructuredOutputs: selected.openaiStructuredOutputs, provider: selected.provider, model: selected.model, customModel: selected.customModel, openaiModel: selected.openaiModel, anthropicModel: selected.anthropicModel, selectionRevision: selected.selectionRevision },
    pendingDecision, webCompletedResponse: changed ? undefined : run.webCompletedResponse, status: pendingDecision ? "awaiting_user" : "answering", error: undefined,
    manualConversationCount: previousProvider !== selected.provider ? 0 : run.manualConversationCount,
    manualNewChatRequired: previousProvider !== selected.provider ? true : run.manualNewChatRequired,
    message: pendingDecision ? "Tiếp tục xử lý câu đang chờ." : "Đang tiếp tục với cấu hình AI đã chọn..."
  };
}

export function isCurrentExecution(run: RunSession | undefined, runId: string, epoch: string): boolean {
  return Boolean(run && run.id === runId && run.executionEpoch === epoch && !["paused", "completed", "error"].includes(run.status));
}
