import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { answerWithExternalApi, listExternalModels } from "../src/auto-provider";
import type { AutoAnswerRequest } from "../src/auto-provider";
import { DEFAULT_SETTINGS } from "../src/defaults";

const request: AutoAnswerRequest = {
  provider: "openai_api", apiKey: "test-secret", model: "model-from-list", requestId: "req-1",
  settings: { ...DEFAULT_SETTINGS, apiPrompt: "Đọc {question}, tài liệu: {documents}" },
  question: { id: "q1", number: "1", type: "single", prompt: "2+2?", images: [{ mimeType: "image/png", data: "YWJj" }], options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }] },
  knowledgeChunks: [{ id: "chunk", courseId: "course", materialId: "doc", materialName: "slide", materialUrl: "https://example.test/doc", kind: "slide", week: "W1", text: "2+2=4" }],
  cacheEvidence: ["Cache phù hợp"]
};
const answer = { requestId: "req-1", questionId: "q1", selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false };
const openai = (text: unknown = answer, status = "completed") => ({ status, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(text) }] }] });
const claude = (text: unknown = answer, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text: JSON.stringify(text) }] });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("official automatic API adapters", () => {
  it("loads model lists and follows Claude pagination", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ data: [{ id: "claude-b", display_name: "B" }], has_more: true, last_id: "cursor" })).mockResolvedValueOnce(response({ data: [{ id: "claude-a", display_name: "A" }], has_more: false }));
    expect((await listExternalModels("anthropic_api", "key", fetcher)).map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(String(fetcher.mock.calls[1]![0])).toContain("after_id=cursor");
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe("Bearer key");
    expect((await listExternalModels("openai_api", "key", vi.fn().mockResolvedValue(response({ data: [{ id: "available" }] })))).map((m) => m.id)).toEqual(["available"]);
    await expect(listExternalModels("openai_api", "", fetcher)).rejects.toThrow("API key");
  });
  it("sends selected context and image in the OpenAI request and validates the answer", async () => {
    const officialShape = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/openai-response-success.json"), "utf8"));
    const fetcher = vi.fn().mockResolvedValue(response(officialShape));
    const result = await answerWithExternalApi(request, new AbortController().signal, fetcher);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.model).toBe("model-from-list");
    expect(body.input[0].content[0].text).toContain("2+2=4");
    expect(body.input[0].content[0].text).toContain("Cache phù hợp");
    expect(body.input[0].content[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,YWJj" });
    expect(body.max_output_tokens).toBe(1024);
    expect(result).toMatchObject({ selectedOptionIds: ["option_1"], source: "openai" });
  });
  it("sends Claude images and keeps independent checks free of cached answers", async () => {
    const officialShape = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/claude-message-success.json"), "utf8"));
    const fetcher = vi.fn().mockResolvedValue(response(officialShape));
    const result = await answerWithExternalApi({ ...request, provider: "anthropic_api", independent: true }, new AbortController().signal, fetcher);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.messages[0].content[1].source).toEqual({ type: "base64", media_type: "image/png", data: "YWJj" });
    expect(body.messages[0].content[0].text).not.toContain("Cache phù hợp");
    expect(body.max_tokens).toBe(1024);
    expect(result).toMatchObject({ source: "anthropic", reasoningPass: true });
  });
  it.each([
    openai({ ...answer, requestId: "old" }), openai({ ...answer, questionId: "old" }),
    openai({ ...answer, selectedOptionIds: ["invalid"] }), openai(answer, "incomplete")
  ])("rejects stale, invalid or incomplete output", async (payload) => {
    await expect(answerWithExternalApi(request, new AbortController().signal, vi.fn().mockResolvedValue(response(payload)))).rejects.toThrow();
  });
  it("rejects truncated Claude output and unsupported images", async () => {
    await expect(answerWithExternalApi({ ...request, provider: "anthropic_api" }, new AbortController().signal, vi.fn().mockResolvedValue(response(claude(answer, "max_tokens"))))).rejects.toThrow();
    const fetcher = vi.fn();
    await expect(answerWithExternalApi({ ...request, question: { ...request.question, images: [{ mimeType: "image/svg+xml", data: "x" }] } }, new AbortController().signal, fetcher)).rejects.toThrow("Ảnh");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("waits for a complete streamed HTTP body before accepting the answer", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const bytes = new TextEncoder().encode(JSON.stringify(openai()));
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(bytes.slice(0, 25)); } });
    let settled = false;
    const pending = answerWithExternalApi(request, new AbortController().signal, vi.fn().mockResolvedValue(new Response(stream))).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    controller.enqueue(bytes.slice(25)); controller.close();
    expect((await pending).selectedOptionIds).toEqual(["option_1"]);
  });
  it("cancels requests and times out without retrying", async () => {
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const signal = new AbortController();
    const pending = answerWithExternalApi(request, signal.signal, fetcher);
    signal.abort();
    await expect(pending).rejects.toThrow("dừng");
    await expect(answerWithExternalApi({ ...request, settings: { ...request.settings, timeoutMs: 5 } }, new AbortController().signal, fetcher)).rejects.toThrow("thời gian");
    expect(fetcher).toHaveBeenCalledTimes(1); // The first cancellation happened before fetch dispatch.
  });
  it("releases a preflight reservation when stopped before the external API dispatch", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn();
    const onNotSent = vi.fn(async () => undefined);
    await expect(answerWithExternalApi(request, controller.signal, fetcher as unknown as typeof fetch, {
      beforeAttempt: async () => { controller.abort(); }, onNotSent
    })).rejects.toThrow("dừng");
    expect(onNotSent).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retries a definite 429 after Retry-After and reports usage from the successful response", async () => {
    const events: string[] = [];
    const limited = { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(limited), { status: 429, headers: { "retry-after": "0.001" } })).mockResolvedValueOnce(response({ ...openai(), usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } }));
    const result = await answerWithExternalApi(request, new AbortController().signal, fetcher, {
      beforeAttempt: async () => { events.push("attempt"); },
      onRejected: async () => { events.push("rejected"); },
      onUsage: async (usage) => { events.push(`usage:${usage?.totalTokens ?? "unknown"}`); }
    });
    expect(result.selectedOptionIds).toEqual(["option_1"]);
    expect(events).toEqual(["attempt", "rejected", "attempt", "usage:20"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not expose raw network exceptions that might contain a secret", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private-secret"));
    await expect(answerWithExternalApi(request, new AbortController().signal, fetcher)).rejects.not.toThrow("private-secret");
    await expect(listExternalModels("openai_api", "private-secret", fetcher)).rejects.not.toThrow("private-secret");
  });
});
