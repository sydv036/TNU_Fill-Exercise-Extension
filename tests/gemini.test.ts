import { describe, expect, it, vi } from "vitest";
import { answerWithGemini, GeminiError, listGeminiModels, recommendedGeminiModels } from "../src/gemini";
import { DEFAULT_SETTINGS } from "../src/defaults";
import type { QuestionSnapshot } from "../src/types";

const question: QuestionSnapshot = {
  id: "question-1", number: "Câu 1", type: "single", prompt: "2 + 2 bằng bao nhiêu?", images: [],
  options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }]
};

describe("Gemini provider", () => {
  it("suggests understandable model choices and marks key availability", () => {
    const recommended = recommendedGeminiModels([{ id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", description: "" }]);
    expect(recommended[0]).toMatchObject({ id: "gemini-3.8-flash", badge: "Khuyên dùng", available: true });
    expect(recommended[1]!.available).toBe(false);
  });
  it("lists only Gemini models supporting generateContent", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] }
    ] }), { status: 200 })) as unknown as typeof fetch;
    await expect(listGeminiModels("key", fetcher)).resolves.toEqual([{ id: "gemini-test", displayName: "Gemini Test", description: "" }]);
  });

  it("parses a schema-constrained answer", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.95, reason: "2 + 2 = 4", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher);
    expect(decision.selectedOptionIds).toEqual(["option_1"]);
    expect(decision.needsHumanReview).toBe(false);
  });

  it("rejects an option id not present on the page", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["answer_B"], confidence: 1, reason: "", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher)).rejects.toThrow(GeminiError);
  });

  it("forces human review below the confidence threshold", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.51, reason: "Không chắc", needsHumanReview: false }) }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test", confidenceThreshold: 0.72 }, question, new AbortController().signal, fetcher);
    expect(decision.needsHumanReview).toBe(true);
  });

  it("adds a deeper verification instruction on the reasoning pass", async () => {
    let requestBody = "";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.91, reason: "Đã kiểm tra", needsHumanReview: false }) }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const decision = await answerWithGemini("key", { ...DEFAULT_SETTINGS, model: "gemini-test" }, question, new AbortController().signal, fetcher, true);
    expect(requestBody).toContain("tự phản biện");
    expect(decision.reasoningPass).toBe(true);
  });
});
