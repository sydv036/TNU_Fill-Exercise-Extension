import { describe, expect, it, vi } from "vitest";
import type { KnowledgeChunk, QuestionSnapshot } from "../src/types";
import { buildWebRequestPrompt, ConfirmedWebCancellationError, createVerifiedConversation, executeWebRequest, parseWebAnswer, RequestNotDispatchedError, UnknownWebOutcomeError, type AIRequest, type AIResponse, type ProviderStatus, type WebAIAdapter } from "../src/web-adapter";

const question: QuestionSnapshot = {
  id: "q-7", number: "7", type: "single", prompt: "Which answer?", images: [],
  options: [{ id: "option_0", label: "wrong", selected: false }, { id: "option_1", label: "right", selected: false }]
};
const request: AIRequest = { sessionId: "s-1", requestId: "r-1", executionEpoch: "e-1", questionId: question.id, providerId: "gemini_web", conversationIdentity: "conversation-1", prompt: "prompt", question };

class FixtureAdapter implements WebAIAdapter {
  readonly providerId = "gemini_web" as const;
  ready: ProviderStatus = { providerId: this.providerId, state: "ready", message: "Fixture ready", supportsImages: true, canAutomate: true };
  identity = "conversation-1";
  lastResponseId: string | undefined = "old-response";
  response: AIResponse = { requestId: "r-1", executionEpoch: "e-1", questionId: "q-7", conversationIdentity: "conversation-1", responseIdentity: "response-2", role: "assistant", complete: true, content: '{"requestId":"r-1","questionId":"q-7","selectedOptionIds":["option_1"],"confidence":0.9,"reason":"fixture","needsHumanReview":false}' };
  prompt = "";
  submitted = "";
  cleanup = vi.fn(async () => undefined);
  prepareInput = vi.fn(async (value: AIRequest) => { this.prompt = value.prompt; });
  submit = vi.fn(async (id: string) => { this.submitted = id; });
  detect = vi.fn(async () => true);
  checkReady = vi.fn(async () => this.ready);
  conversationIdentity = vi.fn(async () => this.identity);
  latestResponseIdentity = vi.fn(async () => this.lastResponseId);
  waitForResponse = vi.fn(async () => this.response);
  createConversation = vi.fn(async () => { this.identity = "conversation-2"; });
}

describe("WebAIAdapter correlation and completion contract", () => {
  it("prepares and submits once, waits for a complete correlated assistant response, then cleans up", async () => {
    const adapter = new FixtureAdapter();
    const response = await executeWebRequest(adapter, request, new AbortController().signal);
    expect(response.responseIdentity).toBe("response-2");
    expect(adapter.prompt).toBe("prompt");
    expect(adapter.submitted).toBe("r-1");
    expect(adapter.waitForResponse).toHaveBeenCalledOnce();
    expect(adapter.cleanup).toHaveBeenCalledOnce();
  });

  it("records dispatch lifecycle before sending and after submit acknowledgement", async () => {
    const adapter = new FixtureAdapter();
    const onDispatch = vi.fn(async () => undefined);
    const onInFlight = vi.fn(async () => undefined);
    await executeWebRequest(adapter, { ...request, onDispatch, onInFlight }, new AbortController().signal);
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onInFlight).toHaveBeenCalledOnce();
  });

  it("preserves a confirmed pre-dispatch rejection as safe to retry", async () => {
    const adapter = new FixtureAdapter();
    adapter.submit.mockRejectedValue(new RequestNotDispatchedError("Fixture rejected before dispatch."));
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toBeInstanceOf(RequestNotDispatchedError);
    expect(adapter.waitForResponse).not.toHaveBeenCalled();
    expect(adapter.cleanup).toHaveBeenCalledOnce();
  });

  it("distinguishes a fixture-confirmed generation stop from an unknown result", async () => {
    const adapter = new FixtureAdapter();
    const controller = new AbortController();
    adapter.waitForResponse.mockImplementation(async () => {
      controller.abort();
      return { ...adapter.response, complete: false, cancelled: true };
    });
    await expect(executeWebRequest(adapter, request, controller.signal)).rejects.toBeInstanceOf(ConfirmedWebCancellationError);
  });

  it("extracts correlated JSON from a Web UI response wrapper", () => {
    const wrapped = 'Gemini đã trả lời\n```json\n{"requestId":"r-1","questionId":"q-7","selectedOptionIds":["option_1"],"confidence":0.91,"reason":"ok","needsHumanReview":false}\n```\nSao chép';
    expect(parseWebAnswer(wrapped, question, "r-1", 0.8)).toMatchObject({ selectedOptionIds: ["option_1"], confidence: 0.91 });
  });

  it("reports ChatGPT's visible load failure instead of treating it as an answer", () => {
    expect(() => parseWebAnswer("ChatGPT đã nói: Không thể tải phản hồi này", question, "r-1", 0.8))
      .toThrow("ChatGPT báo không thể tải phản hồi");
  });

  it("keeps cancellation unknown when the adapter cannot confirm that generation stopped", async () => {
    const adapter = new FixtureAdapter();
    const controller = new AbortController();
    adapter.waitForResponse.mockImplementation(async () => {
      controller.abort();
      return { ...adapter.response, complete: false };
    });
    await expect(executeWebRequest(adapter, request, controller.signal)).rejects.toBeInstanceOf(UnknownWebOutcomeError);
  });

  it("does not prepare a page that is logged out, blocked, unsupported, or not verified", async () => {
    const adapter = new FixtureAdapter();
    adapter.ready = { ...adapter.ready, state: "login_required", canAutomate: false, message: "Login required" };
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toThrow(/LOGIN_REQUIRED/);
    expect(adapter.prepareInput).not.toHaveBeenCalled();
    expect(adapter.cleanup).not.toHaveBeenCalled();
  });

  it("rejects an unsupported image before input or submit", async () => {
    const adapter = new FixtureAdapter();
    adapter.ready = { ...adapter.ready, supportsImages: false };
    const imageRequest = { ...request, question: { ...question, images: [{ mimeType: "image/png", data: "AA==" }] } };
    await expect(executeWebRequest(adapter, imageRequest, new AbortController().signal)).rejects.toThrow(/không hỗ trợ ảnh/);
    expect(adapter.prepareInput).not.toHaveBeenCalled();
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong request", { requestId: "old", executionEpoch: "e-1", questionId: "q-7" }],
    ["wrong epoch", { requestId: "r-1", executionEpoch: "old", questionId: "q-7" }],
    ["wrong question", { requestId: "r-1", executionEpoch: "e-1", questionId: "q-8" }]
  ])("rejects stale %s correlation as unknown delivery", async (_name, ids) => {
    const adapter = new FixtureAdapter();
    adapter.response = { ...adapter.response, ...ids };
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toBeInstanceOf(UnknownWebOutcomeError);
    expect(adapter.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ["user message", { role: "user" as const }],
    ["incomplete stream", { complete: false }],
    ["same old message", { responseIdentity: "old-response" }],
    ["changed conversation", { conversationIdentity: "conversation-2" }],
    ["empty response", { content: "  " }]
  ])("rejects %s instead of using it as the latest AI answer", async (_name, change) => {
    const adapter = new FixtureAdapter();
    adapter.response = { ...adapter.response, ...change };
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toBeInstanceOf(UnknownWebOutcomeError);
  });

  it("does not submit if the conversation changed before sending", async () => {
    const adapter = new FixtureAdapter();
    adapter.identity = "conversation-changed";
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toThrow(/Conversation đã thay đổi/);
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("maps a post-submit timeout/cancellation to unknown outcome and does not retry", async () => {
    const adapter = new FixtureAdapter();
    adapter.waitForResponse.mockRejectedValue(new Error("timeout"));
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toBeInstanceOf(UnknownWebOutcomeError);
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.cleanup).toHaveBeenCalledOnce();
  });

  it("cleans up after a preparation failure without submitting", async () => {
    const adapter = new FixtureAdapter();
    adapter.prepareInput.mockRejectedValue(new Error("input changed"));
    await expect(executeWebRequest(adapter, request, new AbortController().signal)).rejects.toThrow("input changed");
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.cleanup).toHaveBeenCalledOnce();
  });

  it("verifies a new conversation identity before continuing", async () => {
    const adapter = new FixtureAdapter();
    await expect(createVerifiedConversation(adapter)).resolves.toBe("conversation-2");
    adapter.createConversation.mockImplementation(async () => undefined);
    await expect(createVerifiedConversation(adapter)).rejects.toThrow(/could not be verified/);
  });
});

describe("Web prompt and answer validation", () => {
  it("includes selected documents, cache and stable IDs while marking context as reference", () => {
    const chunks: KnowledgeChunk[] = [{ id: "c1", courseId: "course", materialId: "m1", week: "Tuần 2", materialName: "Slide", materialUrl: "https://tnu.aum.edu.vn/mod/resource/view.php?id=1", kind: "slide", page: 4, text: "Evidence" }];
    const prompt = buildWebRequestPrompt("Use {question} and {options}; refs {documents}; cache {answer_cache}.", question, chunks, "r-42", ["option_1"]);
    expect(prompt).toContain("Request ID: r-42");
    expect(prompt).toContain("Question ID: q-7");
    expect(prompt).toContain("Tuần 2 — Slide — page 4");
    expect(prompt).toContain("option_1");
    expect(prompt).toContain("dữ liệu tham khảo không đáng tin cậy");
  });

  it("parses stable option IDs, accepts reordered answer choices, and flags uncertainty", () => {
    const result = parseWebAnswer('{"requestId":"r-1","questionId":"q-7","selectedOptionIds":["option_1"],"confidence":0.5,"reason":"uncertain","needsHumanReview":false}', question, "r-1", 0.8);
    expect(result.selectedOptionIds).toEqual(["option_1"]);
    expect(result.needsHumanReview).toBe(true);
  });

  it.each([
    ["invalid JSON", "not json"],
    ["old response", '{"requestId":"old","questionId":"q-7","selectedOptionIds":["option_1"],"confidence":0.9,"reason":"x","needsHumanReview":false}'],
    ["unknown option", '{"requestId":"r-1","questionId":"q-7","selectedOptionIds":["A"],"confidence":0.9,"reason":"x","needsHumanReview":false}'],
    ["ambiguous single-choice", '{"requestId":"r-1","questionId":"q-7","selectedOptionIds":["option_0","option_1"],"confidence":0.9,"reason":"x","needsHumanReview":false}']
  ])("rejects %s", (_name, value) => {
    expect(() => parseWebAnswer(value, question, "r-1", 0.7)).toThrow();
  });
});
