import type { AnswerDecision, AppSettings, GeminiModel, QuestionSnapshot } from "./types";

type Fetcher = typeof fetch;

export interface RecommendedGeminiModel {
  id: string;
  title: string;
  badge: string;
  description: string;
  available?: boolean;
}

const RECOMMENDED_MODELS: Omit<RecommendedGeminiModel, "available">[] = [
  { id: "gemini-3.8-flash", title: "Gemini 3.8 Flash", badge: "Khuyên dùng", description: "Cân bằng tốt nhất giữa độ chính xác, tốc độ và chi phí cho bài trắc nghiệm." },
  { id: "gemini-3.5-flash-lite", title: "Gemini 3.5 Flash-Lite", badge: "Tiết kiệm", description: "Nhanh và ít tốn quota, phù hợp bài dễ hoặc nhiều câu." },
  { id: "gemini-3.1-pro-preview", title: "Gemini 3.1 Pro", badge: "Suy luận sâu", description: "Phù hợp câu khó, nhưng chậm và tốn chi phí hơn; đây là model preview." }
];

export function recommendedGeminiModels(models: GeminiModel[]): RecommendedGeminiModel[] {
  const availableIds = new Set(models.map((model) => model.id));
  return RECOMMENDED_MODELS.map((model) => ({
    ...model,
    available: models.length ? availableIds.has(model.id) : undefined
  }));
}

export class GeminiError extends Error {
  constructor(message: string, public readonly status = 0, public readonly retryable = false) { super(message); }
}

function modelId(value: string): string {
  return value.replace(/^models\//, "").trim();
}

export async function listGeminiModels(apiKey: string, fetcher: Fetcher = fetch): Promise<GeminiModel[]> {
  if (!apiKey) throw new GeminiError("Chưa có Gemini API key.");
  const response = await fetcher("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": apiKey }
  });
  if (!response.ok) throw new GeminiError(`Không tải được danh sách model (${response.status}).`, response.status);
  const payload = await response.json() as { models?: Array<{ name?: string; displayName?: string; description?: string; supportedGenerationMethods?: string[]; supportedActions?: string[] }> };
  return (payload.models ?? [])
    .filter((item) => [...(item.supportedGenerationMethods ?? []), ...(item.supportedActions ?? [])].includes("generateContent"))
    .filter((item) => item.name?.includes("gemini"))
    .map((item) => ({ id: modelId(item.name ?? ""), displayName: item.displayName || modelId(item.name ?? ""), description: item.description || "" }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function validateDecision(value: unknown, question: QuestionSnapshot, threshold: number): AnswerDecision {
  if (!value || typeof value !== "object") throw new GeminiError("Gemini trả về dữ liệu không hợp lệ.");
  const raw = value as Partial<AnswerDecision>;
  const ids = Array.isArray(raw.selectedOptionIds) ? raw.selectedOptionIds.filter((id): id is string => typeof id === "string") : [];
  const allowed = new Set(question.options.map((option) => option.id));
  if (!ids.length || ids.some((id) => !allowed.has(id))) throw new GeminiError("Gemini trả về phương án không tồn tại.");
  if ((question.type === "single" || question.type === "truefalse") && ids.length !== 1) throw new GeminiError("Gemini trả về sai số lượng phương án.");
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new GeminiError("Gemini trả về confidence không hợp lệ.");
  return {
    selectedOptionIds: [...new Set(ids)],
    confidence,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    needsHumanReview: Boolean(raw.needsHumanReview) || confidence < threshold
  };
}

function buildPrompt(question: QuestionSnapshot, deepReasoning: boolean): string {
  const answers = question.options.map((option) => `${option.id}: ${option.label}`).join("\n");
  return [
    "Bạn là trợ lý học tập. Phân tích câu hỏi trắc nghiệm và chọn phương án đúng nhất.",
    "Chỉ sử dụng đúng option ID đã cung cấp; không dùng chữ cái A/B/C/D.",
    `Loại câu: ${question.type}`,
    `Câu hỏi: ${question.prompt}`,
    "Các phương án:", answers,
    "Nếu không đủ chắc chắn, đặt needsHumanReview=true và confidence phản ánh đúng độ chắc chắn.",
    deepReasoning
      ? "Đây là lượt suy luận lại: hãy kiểm tra từng phương án, tìm bẫy ngôn ngữ, tự phản biện kết luận ban đầu rồi mới trả lời. Nêu ngắn gọn lý do loại các phương án dễ nhầm."
      : "Ưu tiên câu trả lời chính xác và súc tích."
  ].join("\n");
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export async function answerWithGemini(
  apiKey: string,
  settings: AppSettings,
  question: QuestionSnapshot,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  deepReasoning = false
): Promise<AnswerDecision> {
  const model = modelId(settings.customModel || settings.model);
  if (!apiKey) throw new GeminiError("Chưa lưu Gemini API key.");
  if (!model) throw new GeminiError("Chưa chọn Gemini model.");
  const optionIds = question.options.map((option) => option.id);
  const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(question, deepReasoning) }];
  for (const image of question.images) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          selectedOptionIds: { type: "ARRAY", items: { type: "STRING", enum: optionIds } },
          confidence: { type: "NUMBER" },
          reason: { type: "STRING" },
          needsHumanReview: { type: "BOOLEAN" }
        },
        required: ["selectedOptionIds", "confidence", "reason", "needsHumanReview"]
      }
    }
  };
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= settings.retryCount; attempt++) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), settings.timeoutMs);
    const abort = () => timeoutController.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: timeoutController.signal
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new GeminiError(`Gemini API lỗi ${response.status}.`, response.status, retryable);
      }
      const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; promptFeedback?: { blockReason?: string } };
      if (payload.promptFeedback?.blockReason) throw new GeminiError(`Gemini đã chặn nội dung: ${payload.promptFeedback.blockReason}.`);
      const text = payload.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;
      if (!text) throw new GeminiError("Gemini không trả về nội dung.");
      return { ...validateDecision(JSON.parse(text), question, settings.confidenceThreshold), source: "gemini", reasoningPass: deepReasoning };
    } catch (error) {
      if (signal.aborted) throw new GeminiError("Đã dừng yêu cầu Gemini.");
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      const retryable = error instanceof GeminiError && error.retryable;
      if (!retryable || attempt >= settings.retryCount) break;
      await delay(750 * 2 ** attempt, signal);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }
  throw lastError instanceof GeminiError ? lastError : new GeminiError(lastError?.message || "Không thể gọi Gemini.");
}
