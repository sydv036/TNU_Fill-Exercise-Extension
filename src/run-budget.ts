import { ApiError } from "./api-policy";
import { buildManualPrompt } from "./manual-ai";
import type { ProviderUsage } from "./api-policy";
import type { ApiProviderId, AppSettings, KnowledgeChunk, ModelPrice, QuestionSnapshot, RunUsage } from "./types";

const PRICE_HOSTS: Record<ApiProviderId, string[]> = { gemini_api: ["ai.google.dev"], openai_api: ["developers.openai.com", "openai.com"], anthropic_api: ["platform.claude.com", "docs.anthropic.com", "www.anthropic.com"] };
const MAX_OUTPUT_TOKENS = 1024;
export interface ProjectedUsage { inputTokens: number; outputTokens: number; }

export function isValidModelPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== "object") return false;
  const item = value as ModelPrice;
  if (!(item.provider in PRICE_HOSTS) || typeof item.model !== "string" || !item.model.trim() || !Number.isFinite(item.inputUsdPerMillion) || item.inputUsdPerMillion < 0 || !Number.isFinite(item.outputUsdPerMillion) || item.outputUsdPerMillion < 0 || typeof item.checkedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.checkedOn) || !Number.isFinite(Date.parse(item.checkedOn))) return false;
  try { const url = new URL(item.sourceUrl); return url.protocol === "https:" && PRICE_HOSTS[item.provider].includes(url.hostname); } catch { return false; }
}

function currentPrice(prices: ModelPrice[], provider: ApiProviderId, model: string, now = Date.now()): ModelPrice | undefined {
  return prices.find((price) => isValidModelPrice(price) && price.provider === provider && price.model === model && now - Date.parse(`${price.checkedOn}T00:00:00Z`) >= -86400000 && now - Date.parse(`${price.checkedOn}T00:00:00Z`) <= 30 * 86400000);
}

export function estimateUsageUsd(usage: RunUsage | undefined, prices: ModelPrice[] = [], now = Date.now()): number | undefined {
  if (!usage) return 0;
  if (usage.unknownUsageRequests) return undefined;
  let total = 0;
  for (const item of usage.byModel) {
    if (!item.totalTokens && !item.inputTokens && !item.outputTokens) continue;
    const price = currentPrice(prices, item.provider, item.model, now);
    if (!price || item.totalTokens > item.inputTokens + item.outputTokens) return undefined;
    total += (item.inputTokens * price.inputUsdPerMillion + item.outputTokens * price.outputUsdPerMillion) / 1_000_000;
  }
  return total;
}

export function estimatePendingUsageUsd(usage: RunUsage | undefined): number | undefined {
  if (!usage?.pending?.length) return 0;
  let total = 0;
  for (const item of usage.pending) {
    if (item.estimatedCostUsd === undefined || !Number.isFinite(item.estimatedCostUsd)) return undefined;
    total += item.estimatedCostUsd;
  }
  return total;
}

export function estimateRequestTokens(question: QuestionSnapshot, knowledgeChunks: KnowledgeChunk[], cacheEvidence: string[], settings: AppSettings, requestId: string): ProjectedUsage {
  const prompt = buildManualPrompt(settings.apiPrompt, question, knowledgeChunks, requestId, cacheEvidence, "attached");
  // Deliberately conservative local estimate. Vietnamese text can tokenize more densely than English.
  const textTokens = Math.ceil(prompt.length / 1.5) + 256;
  // Image tokenization varies by provider and model. Use a conservative byte-based ceiling, not zero.
  const imageTokens = question.images.reduce((sum, image) => sum + Math.ceil((image.data.length * 3 / 4) / 4) + 256, 0);
  return { inputTokens: textTokens + imageTokens, outputTokens: MAX_OUTPUT_TOKENS };
}

function stopForUnknown(settings: Pick<AppSettings, "unknownUsagePolicy">): boolean {
  return (settings.unknownUsagePolicy ?? "stop") === "stop";
}

export function emptyRunUsage(): RunUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsageRequests: 0, fallbackCount: 0, pending: [], byModel: [] };
}

export function reserveUsage(
  current: RunUsage | undefined,
  settings: Pick<AppSettings, "maxRequests" | "maxTokens"> & Partial<Pick<AppSettings, "maxCostUsd" | "modelPrices" | "unknownUsagePolicy">>,
  provider: ApiProviderId,
  model: string,
  projected?: ProjectedUsage,
  reservationId: string = crypto.randomUUID(),
  now = Date.now(),
  requestId?: string,
  questionId?: string
): RunUsage {
  const usage = current ?? emptyRunUsage();
  const pending = usage.pending ?? [];
  const stopUnknown = stopForUnknown(settings as Pick<AppSettings, "unknownUsagePolicy">);
  if (settings.maxRequests > 0 && usage.requests >= settings.maxRequests) throw new ApiError("Đã chạm giới hạn số yêu cầu API của phiên. Hãy dừng và điều chỉnh ngân sách nếu muốn tiếp tục.", "budget");

  if (settings.maxTokens > 0) {
    const reservedTokens = pending.reduce((sum, item) => sum + (item.inputTokens ?? 0) + (item.outputTokens ?? 0), 0);
    if (usage.totalTokens + reservedTokens >= settings.maxTokens) throw new ApiError("Đã chạm giới hạn token của phiên. Hãy dừng và điều chỉnh ngân sách nếu muốn tiếp tục.", "budget");
    if (usage.unknownUsageRequests > 0 && stopUnknown) throw new ApiError("Không thể xác minh ngân sách token vì lượt trước thiếu usage. Đã dừng an toàn.", "budget");
    const pendingKnown = pending.every((item) => Number.isSafeInteger(item.inputTokens) && Number.isSafeInteger(item.outputTokens));
    if ((!projected || !Number.isSafeInteger(projected.inputTokens) || !Number.isSafeInteger(projected.outputTokens) || !pendingKnown) && stopUnknown) throw new ApiError("Không ước lượng được token trước khi gửi. Đã dừng an toàn theo cài đặt.", "budget");
    const nextTokens = projected ? projected.inputTokens + projected.outputTokens : 0;
    if (usage.totalTokens + reservedTokens + nextTokens > settings.maxTokens) throw new ApiError("Ngân sách token không đủ cho yêu cầu dự kiến; đã dừng trước khi gửi.", "budget");
  }

  const prices = settings.modelPrices ?? [];
  const price = currentPrice(prices, provider, model, now);
  const projectedCost = projected && price ? (projected.inputTokens * price.inputUsdPerMillion + projected.outputTokens * price.outputUsdPerMillion) / 1_000_000 : undefined;
  if ((settings.maxCostUsd ?? 0) > 0) {
    const committed = estimateUsageUsd(usage, prices, now);
    const pendingCost = estimatePendingUsageUsd(usage);
    if ((committed === undefined || pendingCost === undefined || projectedCost === undefined) && stopUnknown) throw new ApiError("Không thể ước lượng chi phí trước khi gửi: thiếu usage hoặc giá model còn hiệu lực. Đã dừng an toàn.", "budget");
    if (committed !== undefined && pendingCost !== undefined && projectedCost !== undefined && committed + pendingCost + projectedCost > settings.maxCostUsd!) throw new ApiError("Ngân sách chi phí ước tính không đủ cho yêu cầu; đã dừng trước khi gửi.", "budget");
  }

  const entries = usage.byModel.map((item) => ({ ...item }));
  let entry = entries.find((item) => item.provider === provider && item.model === model);
  if (!entry) { entry = { provider, model, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }; entries.push(entry); }
  entry.requests++;
  const nextPending = [...pending, { id: reservationId, requestId, questionId, provider, model, status: "reserved" as const, inputTokens: projected?.inputTokens, outputTokens: projected?.outputTokens, estimatedCostUsd: projectedCost }];
  return { ...usage, requests: usage.requests + 1, pending: nextPending, fallbackCount: usage.fallbackCount ?? 0, byModel: entries };
}

export function settleUsage(current: RunUsage, provider: ApiProviderId, model: string, reported?: ProviderUsage, reservationId?: string, definitelyRejected = false): RunUsage {
  const entries = current.byModel.map((item) => ({ ...item }));
  const entry = entries.find((item) => item.provider === provider && item.model === model);
  if (reported && entry) {
    entry.inputTokens += reported.inputTokens; entry.outputTokens += reported.outputTokens; entry.totalTokens += reported.totalTokens;
  }
  const pending = [...(current.pending ?? [])];
  const index = reservationId ? pending.findIndex((item) => item.id === reservationId) : pending.findIndex((item) => item.provider === provider && item.model === model);
  const resolvedUnknown = index >= 0 && pending[index]?.status === "unknown";
  if (index >= 0) pending.splice(index, 1);
  if (!reported && !definitelyRejected) return markUnknownUsage(current, provider, model, reservationId);
  const unknownUsageRequests = current.unknownUsageRequests;
  return {
    ...current,
    inputTokens: current.inputTokens + (reported?.inputTokens ?? 0),
    outputTokens: current.outputTokens + (reported?.outputTokens ?? 0),
    totalTokens: current.totalTokens + (reported?.totalTokens ?? 0),
    unknownUsageRequests: resolvedUnknown ? Math.max(0, unknownUsageRequests - 1) : unknownUsageRequests,
    pending,
    fallbackCount: current.fallbackCount ?? 0,
    byModel: entries
  };
}

export function incrementFallbackCount(current: RunUsage): RunUsage {
  return { ...current, fallbackCount: (current.fallbackCount ?? 0) + 1, pending: [...(current.pending ?? [])] };
}

export function updateReservationStatus(current: RunUsage, reservationId: string, status: NonNullable<RunUsage["pending"][number]["status"]>): RunUsage {
  return { ...current, pending: (current.pending ?? []).map((item) => item.id === reservationId ? { ...item, status } : item) };
}

export function releaseUnsentReservation(current: RunUsage, reservationId: string): RunUsage {
  const item = (current.pending ?? []).find((entry) => entry.id === reservationId);
  if (!item) return current;
  const byModel = current.byModel.map((entry) => entry.provider === item.provider && entry.model === item.model ? { ...entry, requests: Math.max(0, entry.requests - 1) } : entry);
  return { ...current, requests: Math.max(0, current.requests - 1), unknownUsageRequests: item.status === "unknown" ? Math.max(0, current.unknownUsageRequests - 1) : current.unknownUsageRequests, pending: current.pending.filter((entry) => entry.id !== reservationId), byModel };
}

export function markUnknownUsage(current: RunUsage, provider: ApiProviderId, model: string, reservationId?: string, requestId?: string): RunUsage {
  const index = (current.pending ?? []).findIndex((item) => reservationId ? item.id === reservationId : requestId ? item.requestId === requestId : item.provider === provider && item.model === model && item.status !== "unknown");
  if (index < 0) {
    const id = reservationId ?? `unknown:${requestId ?? `${provider}:${model}`}`;
    const alreadyCounted = (current.pending ?? []).some((item) => item.id === id || (requestId && item.requestId === requestId));
    if (alreadyCounted) return current;
    return { ...current, unknownUsageRequests: current.unknownUsageRequests + 1, pending: [...(current.pending ?? []), { id, requestId, provider, model, status: "unknown" }] };
  }
  const pending = [...current.pending];
  const item = pending[index]!;
  if (item.status === "unknown") return current;
  pending[index] = { ...item, requestId: item.requestId ?? requestId, status: "unknown" };
  return { ...current, unknownUsageRequests: current.unknownUsageRequests + 1, pending };
}

export function resolveUnknownReservation(current: RunUsage, requestId: string, resolution: "not_charged" | "count_estimate"): RunUsage {
  const index = (current.pending ?? []).findIndex((item) => item.requestId === requestId && item.status === "unknown");
  if (index < 0) throw new ApiError("Không tìm thấy usage chưa rõ cần đối soát.", "invalid_request");
  const pending = [...current.pending];
  if (resolution === "not_charged") pending.splice(index, 1);
  else pending[index] = { ...pending[index]!, status: "estimated" };
  return { ...current, unknownUsageRequests: Math.max(0, current.unknownUsageRequests - 1), pending };
}
