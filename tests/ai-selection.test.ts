import { describe, expect, it } from "vitest";
import { canChangeSelection, isCurrentExecution, resumeWithSelection, selectedModel } from "../src/ai-selection";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { RunSession } from "../src/types";

const settings = { ...DEFAULT_SETTINGS, provider: "chatgpt_manual" as const, model: "gemini-a" };
const run = { id: "r", executionEpoch: "old", status: "paused", provider: "chatgpt_manual", settingsSnapshot: settings, manualConversationCount: 8, processedQuestionIds: ["done"], currentQuestionSnapshot: { id: "q" }, pendingDecision: { question: { id: "q" }, decision: { manualRequestId: "old-request", selectedOptionIds: [] } } } as unknown as RunSession;

describe("selection and execution identity", () => {
  it("permits changes only when no active execution can write", () => {
    expect(canChangeSelection(undefined)).toBe(true);
    for (const status of ["paused", "idle", "completed", "error"] as const) expect(canChangeSelection({ ...run, status })).toBe(true);
    for (const status of ["answering", "awaiting_user", "preparing", "navigating"] as const) expect(canChangeSelection({ ...run, status })).toBe(false);
  });
  it("resumes using the committed provider/model and preserves position", () => {
    const next = resumeWithSelection(run, { ...settings, provider: "gemini_api", model: "gemini-b" }, "new");
    expect(next).toMatchObject({ id: "r", executionEpoch: "new", provider: "gemini_api", status: "answering", processedQuestionIds: ["done"], currentQuestionSnapshot: { id: "q" }, manualConversationCount: 0 });
    expect(next.pendingDecision).toBeUndefined();
    expect(selectedModel(next.settingsSnapshot!)).toBe("gemini-b");
    expect(isCurrentExecution(next, "r", "old")).toBe(false);
    expect(isCurrentExecution(next, "r", "new")).toBe(true);
  });
  it("keeps a completed pending suggestion only when selection did not change", () => {
    const pending = { ...run, pendingDecision: { question: { id: "q" }, decision: { selectedOptionIds: ["option_0"] } } } as unknown as RunSession;
    expect(resumeWithSelection(pending, settings, "new").status).toBe("awaiting_user");
    expect(resumeWithSelection(pending, { ...settings, provider: "claude_manual" }, "new").pendingDecision).toBeUndefined();
    expect(resumeWithSelection(pending, { ...settings, selectionRevision: "switched-away-and-back" }, "new").pendingDecision).toBeUndefined();
    expect(isCurrentExecution(undefined, "r", "x")).toBe(false);
    expect(isCurrentExecution({ ...run, status: "paused" }, "r", "old")).toBe(false);
  });
  it("recovers a durable completed Web response without resending, but discards it on provider switch", () => {
    const webSettings = { ...DEFAULT_SETTINGS, provider: "gemini_web" as const };
    const recoverable = {
      ...run,
      provider: "gemini_web",
      status: "paused" as const,
      settingsSnapshot: webSettings,
      activeExecution: { requestId: "web-request", executionEpoch: "old", questionId: "q", providerId: "gemini_web", modelId: "", status: "completed" as const },
      webCompletedResponse: { question: { id: "q" }, decision: { selectedOptionIds: ["option_1"], executionRequestId: "web-request" } }
    } as unknown as RunSession;
    const sameProvider = resumeWithSelection(recoverable, webSettings, "resumed");
    expect(sameProvider.activeExecution).toMatchObject({ requestId: "web-request", executionEpoch: "resumed", status: "completed" });
    expect(sameProvider.webCompletedResponse?.decision.executionRequestId).toBe("web-request");
    const switched = resumeWithSelection(recoverable, { ...webSettings, provider: "gemini_api" }, "switched");
    expect(switched.activeExecution).toBeUndefined();
    expect(switched.webCompletedResponse).toBeUndefined();
  });
  it("preserves the current position when resuming a legacy from-current session", () => {
    const legacy = { ...run, mode: "from_current" as const, startAnchorUsed: true, page: 2, currentQuestion: 7, startAnchorPage: undefined, startAnchorIndex: undefined };
    expect(resumeWithSelection(legacy, settings, "new")).toMatchObject({ startAnchorPage: 2, startAnchorIndex: 6 });
  });
  it("applies updated API and Web timeout settings when resuming", () => {
    const next = resumeWithSelection(run, { ...settings, timeoutMs: 45_000, webTimeoutMs: 900_000 }, "new");
    expect(next.settingsSnapshot).toMatchObject({ timeoutMs: 45_000, webTimeoutMs: 900_000 });
  });
});
