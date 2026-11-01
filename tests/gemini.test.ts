import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { answerKnowledgeWithGemini, answerWithGemini, GeminiError, listGeminiModels, recommendedGeminiModels } from "../src/gemini";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { KnowledgeChunk, QuestionSnapshot } from "../src/types";
import { migrateSettings } from "../src/storage";

const question: QuestionSnapshot = {
  id: "question-1", number: "Câu 1", type: "single", prompt: "2 + 2 bằng bao nhiêu?", images: [],
  options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }]
};

describe("Gemini provider", () => {
  it("only presents models actually discovered for the key", () => {
    const recommended = recommendedGeminiModels([{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", description: "" }]);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toMatchObject({ id: "gemini-3.8-flash", badge: "Khả dụng", available: true });
    expect(recommendedGeminiModels([])).toEqual([]);
  });

  it("loads every page of supported models without inventing identifiers", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).includes("pageToken=next")
      ? { models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }
      : { models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" }), { status: 200 })) as unknown as typeof fetch;
    expect((await listGeminiModels("key", fetcher)).map((model) => model.id)).toEqual(["gemini-a", "gemini-b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated pagination tokens instead of looping indefinitely", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [], nextPageToken: "same" }), { status: 200 })) as unknown as typeof fetch;
    await expect(listGeminiModels("key", fetcher)).rejects.toThrow("trang lặp");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("lists only named models supporting generateContent", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] }
    ] }), { status: 200 })) as unknown as typeof fetch;
    await expect(listGeminiModels("key", fetcher)).resolves.toEqual([{ id: "gemini-test", displayName: "Gemini Test", description: "" }]);
  });

  it("accepts model action metadata and handles model-list failures", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "models/gemini-x", supportedActions: ["generateContent"] }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(listGeminiModels("key", fetcher)).resolves.toEqual([{ id: "gemini-x", displayName: "gemini-x", description: "" }]);
    await expect(listGeminiModels("", fetcher)).rejects.toThrow("API key");
    const failed = vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(listGeminiModels("key", failed)).rejects.toThrow("403");
    expect(recommendedGeminiModels([])[0]?.available).toBeUndefined();
  });

  it("preserves explicit review requests and sends question images", async () => {
    let sent = "";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = String(init?.body);
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.9, reason: "", needsHumanReview: true }) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, { ...question, images: [{ mimeType: "image/png", data: "YWJj" }] }, new AbortController().signal, fetcher);
    expect(decision).toMatchObject({ needsHumanReview: true, reason: "" });
    expect(sent).toContain("image/png");
  });

  it("parses a schema-constrained answer", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.95, reason: "2 + 2 = 4", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher);
    expect(decision.selectedOptionIds).toEqual(["option_1"]);
    expect(decision.needsHumanReview).toBe(false);
  });
  it("parses a sanitized provider response fixture, requires completion, and records usage", async () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/gemini-success.json"), "utf8"));
    let usage: unknown;
    let requestBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { requestBody = JSON.parse(String(init?.body)); return new Response(JSON.stringify(fixture)); }) as unknown as typeof fetch;
    const answer = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, question, new AbortController().signal, fetcher, false, [], [], { onUsage: async (value) => { usage = value; } });
    expect(answer.selectedOptionIds).toEqual(["option_1"]);
    expect(usage).toEqual({ inputTokens: 34, outputTokens: 20, totalTokens: 54 });
    expect(requestBody?.generationConfig).toMatchObject({ maxOutputTokens: 1024, responseMimeType: "application/json" });
  });
  it("rejects a truncated response even when the partial JSON looks valid", async () => {
    const value = { selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(value) }] } }] }))) as unknown as typeof fetch;
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, question, new AbortController().signal, fetcher)).rejects.toThrow("cắt ngắn");
  });
  it("rejects missing required decision fields and non-string option IDs", async () => {
    for (const value of [{ selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4" }, { selectedOptionIds: ["option_1", 1], confidence: 0.9, reason: "4", needsHumanReview: false }]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] }))) as unknown as typeof fetch;
      await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, question, new AbortController().signal, fetcher)).rejects.toThrow();
    }
  });

  it("rejects an option id not present on the page", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["answer_B"], confidence: 1, reason: "", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher)).rejects.toThrow(GeminiError);
  });

  it("rejects duplicate choices in a multi-select response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1", "option_1"], confidence: 1, reason: "", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, { ...question, type: "multiple" }, new AbortController().signal, fetcher)).rejects.toThrow("bị lặp");
  });

  it.each([
    { selectedOptionIds: [], confidence: 1, needsHumanReview: false },
    { selectedOptionIds: ["option_0", "option_1"], confidence: 1, needsHumanReview: false },
    { selectedOptionIds: ["option_1"], confidence: -0.1, needsHumanReview: false },
    { selectedOptionIds: ["option_1"], confidence: 1.1, needsHumanReview: false }
  ])("rejects invalid API answer payloads", async (payload) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(payload) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, question, new AbortController().signal, fetcher)).rejects.toThrow();
  });

  it("surfaces API safety blocks and empty responses", async () => {
    const settings = { ...DEFAULT_SETTINGS, model: "m" };
    const blocked = vi.fn(async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })) as unknown as typeof fetch;
    const empty = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(answerWithGemini("key", settings, question, new AbortController().signal, blocked)).rejects.toThrow("chặn");
    await expect(answerWithGemini("key", settings, question, new AbortController().signal, empty)).rejects.toThrow("không trả về");
  });

  it("forces human review below the confidence threshold", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.51, reason: "Không chắc", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test", confidenceThreshold: 0.72 }, question, new AbortController().signal, fetcher);
    expect(decision.needsHumanReview).toBe(true);
  });

  it("adds a deeper verification instruction on the reasoning pass", async () => {
    let requestBody = "";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.91, reason: "Đã kiểm tra", needsHumanReview: false }) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher, true);
    expect(requestBody).toContain("tự phản biện");
    expect(decision.reasoningPass).toBe(true);
  });

  it("does not dispatch when already cancelled or retry a server error", async () => {
    const fetcher = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, controller.signal, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test", retryCount: 2 }, question, new AbortController().signal, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation when stopped after preflight but before dispatch", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn() as unknown as typeof fetch;
    const onNotSent = vi.fn(async () => undefined);
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, question, controller.signal, fetcher, false, [], [], {
      beforeAttempt: async () => { controller.abort(); }, onNotSent
    })).rejects.toThrow("dừng");
    expect(onNotSent).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("includes indexed course material only when context is supplied", async () => {
    let requestBody = "";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.95, reason: "Theo giáo trình", needsHumanReview: false }) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const context: KnowledgeChunk[] = [{
      id: "chunk-1", courseId: "11086", materialId: "m1", materialName: "Giáo trình Bài 1",
      materialUrl: "https://tnu.aum.edu.vn/mod/resource/view.php?id=1", week: "Tuần 1", kind: "textbook", page: 4,
      text: "Tài liệu xác nhận phép cộng hai cộng hai bằng bốn."
    }];
    await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher, false, context);
    expect(requestBody).toContain("Giáo trình Bài 1");
    expect(requestBody).toContain("trang 4");
  });

  it("migrates old settings with document lookup disabled and remembers an explicit choice", () => {
    expect(migrateSettings({ schemaVersion: 2, model: "gemini-test" }).useCourseKnowledgeForAnswers).toBe(false);
    expect(migrateSettings({ ...DEFAULT_SETTINGS, useCourseKnowledgeForAnswers: true }).useCourseKnowledgeForAnswers).toBe(true);
  });

  it("returns only citations belonging to the provided source chunks", async () => {
    const chunks: KnowledgeChunk[] = [{ id: "c1", courseId: "c", materialId: "m1", materialName: "Giáo trình", materialUrl: "url", week: "1", kind: "textbook", page: 2, text: "Nội dung" }];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ answer: "Nội dung [1]", citedChunkIds: ["c1", "foreign", "c1"], insufficientEvidence: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await answerKnowledgeWithGemini("key", { ...DEFAULT_SETTINGS, model: "m" }, "hỏi", chunks, new AbortController().signal, fetcher);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({ chunkId: "c1", page: 2 });
  });

  it("rejects malformed knowledge responses and avoids a request with no evidence", async () => {
    const settings = { ...DEFAULT_SETTINGS, model: "m" };
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"answer":123}' }] } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(answerKnowledgeWithGemini("key", settings, "hỏi", [], signal, fetcher)).resolves.toMatchObject({ insufficientEvidence: true });
    expect(fetcher).not.toHaveBeenCalled();
    const chunks: KnowledgeChunk[] = [{ id: "c", courseId: "c", materialId: "m", materialName: "T", materialUrl: "url", week: "1", kind: "slide", text: "N" }];
    await expect(answerKnowledgeWithGemini("key", settings, "hỏi", chunks, signal, fetcher)).rejects.toThrow("không hợp lệ");
    await expect(answerKnowledgeWithGemini("", settings, "hỏi", chunks, signal, fetcher)).rejects.toThrow("API key");
    await expect(answerKnowledgeWithGemini("key", { ...settings, model: "" }, "hỏi", chunks, signal, fetcher)).rejects.toThrow("model");
  });
});
