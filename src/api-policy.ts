import type { ApiProviderId } from "./types";

export type ApiErrorKind = "invalid_request" | "authentication" | "not_found" | "rate_limit" | "server" | "network" | "timeout" | "cancelled" | "invalid_response" | "truncated" | "budget";
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind: ApiErrorKind,
    public readonly status = 0,
    public readonly definitelyRejected = false,
    public readonly retryAfter: string | null = null,
    public readonly retryable = false,
    public readonly fallbackAllowed = false,
    public readonly providerCode?: string
  ) { super(message); }
}

export interface ProviderUsage { inputTokens: number; outputTokens: number; totalTokens: number; }
export interface RequestHooks {
  beforeAttempt?: (provider: ApiProviderId, model: string) => Promise<void>;
  onDispatch?: () => Promise<void>;
  onInFlight?: () => Promise<void>;
  onNotSent?: () => Promise<void>;
  onUnknown?: () => Promise<void>;
  onUsage?: (usage?: ProviderUsage) => Promise<void>;
  onRejected?: () => Promise<void>;
}

export type ProviderErrorDisposition = "temporary_rate_limit" | "quota" | "daily_quota" | "billing" | "spend_limit" | "overload" | "unknown_rate_limit" | "other";
export interface ProviderErrorClassification {
  disposition: ProviderErrorDisposition;
  code?: string;
  retryable: boolean;
  fallbackAllowed: boolean;
}

function normalizedCode(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function collectErrorCodes(provider: string, body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  const result: string[] = [];
  const add = (value: unknown) => { const code = normalizedCode(value); if (code) result.push(code); };
  add(error.code); add(error.type); add(error.status);
  if (error.details && typeof error.details === "object") {
    const details = error.details as Record<string, unknown>;
    add(details.error_code); add(details.reason); add(details.code);
  }
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const item = value as Record<string, unknown>;
    add(item.reason); add(item.error_code); add(item.code);
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(error.details);
  // Gemini uses Google RPC status codes while OpenAI/Anthropic use error.code/type.
  if (provider.toLowerCase().includes("gemini")) add(root.status);
  return [...new Set(result)];
}

export function classifyProviderError(provider: string, status: number, body: unknown, retryAfter: string | null = null): ProviderErrorClassification {
  const codes = collectErrorCodes(provider, body);
  const code = codes.find((value) => value !== "error") ?? codes[0];
  const joined = codes.join(" ");
  if (/(credit_balance_exhausted|insufficient_quota|payment_required|billing_error|prepay|credit_balance|billing)/.test(joined)) return { disposition: "billing", code, retryable: false, fallbackAllowed: false };
  if (/(spend_limit|spend_cap|spending_limit|enforced_spend|organization_usage_limit|project_usage_limit)/.test(joined)) return { disposition: "spend_limit", code, retryable: false, fallbackAllowed: false };
  if (/(daily_quota|quota_exceeded|quota_exhausted|daily.*quota|tpm_daily)/.test(joined)) return { disposition: "daily_quota", code, retryable: false, fallbackAllowed: false };
  if (/(overloaded_error|server_is_overloaded|service_unavailable|overload)/.test(joined) || status === 529) return { disposition: "overload", code, retryable: true, fallbackAllowed: true };
  if (status === 429) {
    if (provider.toLowerCase().includes("claude") && joined.includes("rate_limit_error") && !retryAfter) return { disposition: "unknown_rate_limit", code, retryable: false, fallbackAllowed: false };
    if (/(rate_limit_exceeded|too_many_requests|slow_down|rate_limit_error|rate_limit_exhausted)/.test(joined)) return { disposition: "temporary_rate_limit", code, retryable: true, fallbackAllowed: true };
    // Gemini's RPC status RESOURCE_EXHAUSTED is ambiguous without a quota reason or Retry-After.
    if (provider.toLowerCase().includes("gemini") && joined.includes("resource_exhausted") && retryAfter) return { disposition: "temporary_rate_limit", code, retryable: true, fallbackAllowed: true };
    return { disposition: "unknown_rate_limit", code, retryable: false, fallbackAllowed: false };
  }
  return { disposition: "other", code, retryable: false, fallbackAllowed: false };
}

export async function providerApiError(provider: string, response: Response): Promise<ApiError> {
  const status = response.status;
  let body: unknown;
  try { body = await response.clone().json(); } catch { body = undefined; }
  const classification = classifyProviderError(provider, status, body, response.headers.get("retry-after"));
  const base = httpApiError(provider, response);
  let message = base.message;
  if (classification.disposition === "billing") message = `${provider} API: tài khoản cần bổ sung tín dụng hoặc sửa thanh toán; không tự thử lại.`;
  else if (classification.disposition === "spend_limit") message = `${provider} API: đã chạm giới hạn chi tiêu hoặc sử dụng của tài khoản; không tự thử lại.`;
  else if (classification.disposition === "daily_quota") message = `${provider} API: đã hết hạn mức ngày; cần chờ đặt lại hoặc điều chỉnh hạn mức.`;
  else if (classification.disposition === "unknown_rate_limit") message = `${provider} API trả HTTP 429 với mã chưa xác định; đã dừng để tránh retry hoặc fallback sai.`;
  else if (classification.disposition === "temporary_rate_limit") message = `${provider} API tạm giới hạn tốc độ; đang áp dụng retry có giới hạn.`;
  else if (classification.disposition === "overload") message = `${provider} API đang quá tải; chỉ retry/fallback theo số lần đã cấu hình.`;
  const isClientRejection = status >= 400 && status < 500;
  return new ApiError(message, status === 429 ? "rate_limit" : status === 529 ? "server" : base.kind, status, isClientRejection || classification.disposition === "overload", response.headers.get("retry-after"), classification.retryable, classification.fallbackAllowed, classification.code);
}

export function isSupportedImage(mimeType: string, data: string): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType) && Boolean(data) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data);
}

export function httpApiError(provider: string, response: Response): ApiError {
  const status = response.status;
  const kind: ApiErrorKind = status === 400 || status === 413 ? "invalid_request" : status === 401 || status === 403 ? "authentication" : status === 404 ? "not_found" : status === 429 ? "rate_limit" : status >= 500 ? "server" : "invalid_request";
  const hint = kind === "authentication" ? "key hoặc quyền truy cập" : kind === "rate_limit" ? "giới hạn tốc độ hoặc hạn mức" : kind === "not_found" ? "model hoặc endpoint" : kind === "server" ? "máy chủ" : "yêu cầu hoặc giới hạn ngữ cảnh";
  return new ApiError(`${provider} API lỗi HTTP ${status}: hãy kiểm tra ${hint}.`, kind, status, status >= 400 && status < 500, response.headers.get("retry-after"));
}

export function retryDelayMs(attempt: number, retryAfter: string | null, now = Date.now(), random = Math.random): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    // Excessive provider-specified waits are surfaced instead of retrying earlier than requested.
    if (Number.isFinite(ms) && ms > 30_000) return -1;
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  }
  return Math.min(30_000, Math.round(750 * 2 ** attempt * (0.75 + random() * 0.5)));
}

export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ApiError("Yêu cầu đã dừng.", "cancelled")); return; }
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ApiError("Yêu cầu đã dừng.", "cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function normalizeUsage(input: unknown, output: unknown, total?: unknown): ProviderUsage | undefined {
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || (input as number) < 0 || (output as number) < 0) return undefined;
  const sum = (input as number) + (output as number);
  return { inputTokens: input as number, outputTokens: output as number, totalTokens: Number.isSafeInteger(total) && (total as number) >= sum ? total as number : sum };
}
