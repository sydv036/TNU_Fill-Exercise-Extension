import { buildManualPrompt, parseManualResponse } from "./manual-ai";
import { ApiError, providerApiError, isSupportedImage, normalizeUsage, retryDelayMs, waitForRetry } from "./api-policy";
import type { RequestHooks } from "./api-policy";
import type { AnswerDecision, AppSettings, GeminiModel, KnowledgeChunk, QuestionSnapshot } from "./types";

export type ExternalApiProvider = "openai_api" | "anthropic_api";
const BASE: Record<ExternalApiProvider, string> = { openai_api: "https://api.openai.com/v1", anthropic_api: "https://api.anthropic.com/v1" };

function headers(provider: ExternalApiProvider, key: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...(provider === "anthropic_api" ? { "anthropic-version": "2023-06-01" } : {}) };
}

export async function listExternalModels(provider: ExternalApiProvider, key: string, fetcher: typeof fetch = fetch): Promise<GeminiModel[]> {
  if (!key) throw new Error("Chưa lưu API key cho nhà cung cấp này.");
  const found = new Map<string, GeminiModel>();
  const seen = new Set<string>();
  let cursor = "";
  do {
    const url = new URL(`${BASE[provider]}/models`);
    if (provider === "anthropic_api") { url.searchParams.set("limit", "1000"); if (cursor) url.searchParams.set("after_id", cursor); }
    let response: Response;
    try { response = await fetcher(url.toString(), { headers: headers(provider, key) }); }
    catch { throw new ApiError("Không thể kết nối API để tải danh sách model.", "network"); }
    if (!response.ok) throw await providerApiError(provider === "openai_api" ? "OpenAI" : "Claude", response);
    let payload: { data?: Array<{ id?: unknown; display_name?: unknown; lifecycle?: unknown }>; has_more?: boolean; last_id?: string | null };
    try { payload = await response.json() as typeof payload; } catch { throw new ApiError("Danh sách model không hợp lệ.", "invalid_response"); }
    if (!Array.isArray(payload.data)) throw new Error("Danh sách model không hợp lệ.");
    for (const item of payload.data) {
      if (typeof item.id !== "string" || !item.id.trim() || item.lifecycle === "retired") continue;
      found.set(item.id, { id: item.id, displayName: typeof item.display_name === "string" ? item.display_name : item.id, description: "" });
    }
    if (provider !== "anthropic_api" || !payload.has_more) break;
    cursor = payload.last_id ?? "";
    if (!cursor || seen.has(cursor)) throw new Error("Không thể phân trang danh sách model Claude.");
    seen.add(cursor);
  } while (true);
  return [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export interface AutoAnswerRequest {
  provider: ExternalApiProvider;
  apiKey: string;
  model: string;
  requestId: string;
  settings: AppSettings;
  question: QuestionSnapshot;
  knowledgeChunks: KnowledgeChunk[];
  cacheEvidence: string[];
  independent?: boolean;
}

// Each request is a separate conversation; we do not rely on previous response IDs.
export async function answerWithExternalApi(request: AutoAnswerRequest, signal: AbortSignal, fetcher: typeof fetch = fetch, hooks: RequestHooks = {}): Promise<AnswerDecision> {
  const { provider, apiKey, model, requestId, settings, question, knowledgeChunks } = request;
  if (!apiKey || !model) throw new Error("Hãy cấu hình API key và model trước khi chạy.");
  if (signal.aborted) throw new Error("Yêu cầu AI đã được dừng.");
  for (const image of question.images) if (!isSupportedImage(image.mimeType, image.data)) throw new Error("Ảnh câu hỏi không ở định dạng API hỗ trợ; không gửi câu thiếu ảnh.");
  const instruction = request.independent ? "Hãy giải độc lập và kiểm tra từng phương án, không giả định đáp án ban đầu." : settings.apiPrompt;
  const prompt = buildManualPrompt(instruction, question, knowledgeChunks, requestId, request.independent ? [] : request.cacheEvidence, "attached");
  const body = provider === "openai_api" ? {
    model, store: false, max_output_tokens: 1024,
    ...(settings.openaiStructuredOutputs ? { text: { format: { type: "json_schema", name: "tnu_answer", strict: true, schema: {
      type: "object", additionalProperties: false,
      properties: { requestId: { type: "string" }, questionId: { type: "string" }, selectedOptionIds: { type: "array", items: { type: "string", enum: question.options.map((option) => option.id) } }, confidence: { type: "number" }, reason: { type: "string" }, needsHumanReview: { type: "boolean" } },
      required: ["requestId", "questionId", "selectedOptionIds", "confidence", "reason", "needsHumanReview"]
    } } } } : {}),
    input: [{ role: "user", content: [
      { type: "input_text", text: prompt },
      ...question.images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" }))
    ] }]
  } : {
    model, max_tokens: 1024, messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      ...question.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))
    ] }]
  };
  for (let attempt = 0; attempt <= settings.retryCount; attempt++) {
  let responseReceived = false;
  try { if (hooks.beforeAttempt) await hooks.beforeAttempt(provider, model); }
  catch (error) { await hooks.onNotSent?.(); throw error; }
  if (signal.aborted) { await hooks.onNotSent?.(); throw new ApiError("Yêu cầu AI đã được dừng cục bộ.", "cancelled"); }
  try { await hooks.onDispatch?.(); }
  catch (error) { await hooks.onNotSent?.(); throw error; }
  if (signal.aborted) { await hooks.onNotSent?.(); throw new ApiError("Yêu cầu AI đã được dừng cục bộ.", "cancelled"); }
  try { await hooks.onInFlight?.(); }
  catch (error) { await hooks.onNotSent?.(); throw error; }
  if (signal.aborted) { await hooks.onNotSent?.(); throw new ApiError("Yêu cầu AI đã được dừng cục bộ.", "cancelled"); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await fetcher(`${BASE[provider]}/${provider === "openai_api" ? "responses" : "messages"}`, { method: "POST", headers: headers(provider, apiKey), body: JSON.stringify(body), signal: controller.signal });
    responseReceived = true;
    if (!response.ok) {
      const failure = await providerApiError(provider === "openai_api" ? "OpenAI" : "Claude", response);
      if (failure.definitelyRejected) await hooks.onRejected?.();
      else await hooks.onUnknown?.();
      throw failure;
    }
    let payload: {
      status?: unknown; stop_reason?: unknown;
      output?: Array<{ type?: string; role?: string; status?: string; content?: Array<{ type?: string; text?: string }> }>;
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown };
    };
    try { payload = await response.json() as typeof payload; }
    catch { await hooks.onUsage?.(undefined); throw new ApiError("API trả về JSON không hợp lệ; usage không xác định.", "invalid_response"); }
    const meta = payload.usage;
    const input = Number.isSafeInteger(meta?.input_tokens) ? (meta?.input_tokens as number) + (provider === "anthropic_api" && Number.isSafeInteger(meta?.cache_creation_input_tokens) ? meta?.cache_creation_input_tokens as number : 0) + (provider === "anthropic_api" && Number.isSafeInteger(meta?.cache_read_input_tokens) ? meta?.cache_read_input_tokens as number : 0) : undefined;
    const usage = normalizeUsage(input, meta?.output_tokens, meta?.total_tokens);
    await hooks.onUsage?.(usage);
    if (signal.aborted || controller.signal.aborted) throw new Error("Yêu cầu AI đã dừng hoặc quá thời gian.");
    let text: string | undefined;
    if (provider === "openai_api") {
      if (payload.status !== "completed") throw new ApiError("OpenAI chưa hoàn tất phản hồi.", "truncated");
      const messages = (payload.output ?? []).filter((item) => item.type === "message" && item.role === "assistant" && item.status === "completed");
      const parts = messages.flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text" && typeof part.text === "string");
      if (messages.length !== 1 || parts.length !== 1) throw new Error("Phản hồi OpenAI thiếu nội dung hoặc không xác định duy nhất.");
      text = parts[0]?.text;
    } else {
      if (payload.stop_reason !== "end_turn") throw new ApiError("Claude chưa hoàn tất phản hồi hoặc đã từ chối.", "truncated");
      const parts = (payload.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string");
      if (parts.length !== 1) throw new Error("Phản hồi Claude thiếu nội dung hoặc không xác định duy nhất.");
      text = parts[0]?.text;
    }
    const parsed = parseManualResponse(text ?? "", question, settings.confidenceThreshold, requestId);
    return { ...parsed, source: provider === "openai_api" ? "openai" : "anthropic", reasoningPass: Boolean(request.independent) };
  } catch (error) {
    if (signal.aborted) {
      if (responseReceived) await hooks.onUsage?.(undefined);
      else await hooks.onUnknown?.();
      throw new ApiError("Yêu cầu AI đã được dừng cục bộ.", "cancelled");
    }
    if (controller.signal.aborted) {
      if (responseReceived) await hooks.onUsage?.(undefined);
      else await hooks.onUnknown?.();
      throw new ApiError(responseReceived ? "Đã nhận phản hồi nhưng thiếu usage; không gửi lại tự động." : "Yêu cầu AI quá thời gian; trạng thái gửi có thể chưa rõ.", "timeout");
    }
    const failure = error instanceof ApiError ? error : new ApiError("Lỗi mạng hoặc phản hồi AI không hợp lệ; trạng thái gửi có thể chưa rõ.", "invalid_response");
    if (failure.kind === "network" || failure.kind === "timeout") await hooks.onUnknown?.();
    if (!failure.retryable || attempt >= settings.retryCount) throw failure;
    const wait = retryDelayMs(attempt, failure.retryAfter);
    if (wait < 0) throw failure;
    await waitForRetry(wait, signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  }
  throw new ApiError("Không thể gọi API.", "network");
}
