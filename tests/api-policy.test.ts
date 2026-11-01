import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RunUsage } from "../src/types";
import { classifyProviderError, httpApiError, normalizeUsage, providerApiError, retryDelayMs } from "../src/api-policy";
import { estimatePendingUsageUsd, estimateUsageUsd, isValidModelPrice, reserveUsage, settleUsage, incrementFallbackCount, markUnknownUsage, releaseUnsentReservation, resolveUnknownReservation, updateReservationStatus } from "../src/run-budget";

describe("API errors, retry and session budgets", () => {
  it.each([[400, "invalid_request"], [401, "authentication"], [403, "authentication"], [404, "not_found"], [429, "rate_limit"], [500, "server"]] as const)("classifies HTTP %i without exposing the response body", (status, kind) => {
    const error = httpApiError("Test", new Response("secret-key-in-body", { status }));
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("secret-key-in-body");
    expect(error.definitelyRejected).toBe(status < 500);
  });
  it("honors Retry-After, adds bounded jitter, and refuses to retry too early", () => {
    expect(retryDelayMs(0, "2", 0, () => 0)).toBe(2000);
    expect(retryDelayMs(1, null, 0, () => 0)).toBe(1125);
    expect(retryDelayMs(1, null, 0, () => 1)).toBe(1875);
    expect(retryDelayMs(0, "31", 0)).toBe(-1);
    expect(retryDelayMs(0, "Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
  });
  it("classifies provider-specific 429s and overloads without retrying quota or billing failures", async () => {
    const geminiTemporary = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/gemini-temporary-rate-limit.json"), "utf8"));
    const openaiCredit = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/openai-insufficient-credit.json"), "utf8"));
    const claudeSpend = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/claude-spend-limit.json"), "utf8"));
    expect(classifyProviderError("Gemini", 429, geminiTemporary)).toMatchObject({ disposition: "temporary_rate_limit", retryable: true, fallbackAllowed: true });
    expect(classifyProviderError("OpenAI", 429, { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } })).toMatchObject({ disposition: "temporary_rate_limit", retryable: true, fallbackAllowed: true });
    expect(classifyProviderError("OpenAI", 429, openaiCredit)).toMatchObject({ disposition: "billing", retryable: false, fallbackAllowed: false });
    expect(classifyProviderError("Gemini", 429, { error: { status: "QUOTA_EXCEEDED" } })).toMatchObject({ disposition: "daily_quota", retryable: false, fallbackAllowed: false });
    expect(classifyProviderError("Claude", 429, claudeSpend)).toMatchObject({ disposition: "spend_limit", retryable: false, fallbackAllowed: false });
    expect(classifyProviderError("Claude", 429, { error: { type: "rate_limit_error" } })).toMatchObject({ disposition: "unknown_rate_limit", retryable: false, fallbackAllowed: false });
    expect(classifyProviderError("Claude", 429, { error: { type: "rate_limit_error" } }, "2")).toMatchObject({ disposition: "temporary_rate_limit", retryable: true, fallbackAllowed: true });
    expect(classifyProviderError("Claude", 529, { error: { type: "overloaded_error" } })).toMatchObject({ disposition: "overload", retryable: true, fallbackAllowed: true });
    const safe = await providerApiError("OpenAI", new Response(JSON.stringify({ error: { message: "secret-token", code: "credit_balance_exhausted" } }), { status: 429 }));
    expect(safe.message).not.toContain("secret-token");
    expect(safe.fallbackAllowed).toBe(false);
  });
  it("counts attempts by provider/model and blocks the next request at the request limit", () => {
    const settings = { maxRequests: 1, maxTokens: 0 };
    const reserved = reserveUsage(undefined, settings, "openai_api", "m1");
    const reported = settleUsage(reserved, "openai_api", "m1", { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(reported).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, unknownUsageRequests: 0, byModel: [{ provider: "openai_api", model: "m1", requests: 1, totalTokens: 15 }] });
    expect(() => reserveUsage(reported, settings, "anthropic_api", "m2")).toThrow("giới hạn số yêu cầu");
  });
  it("reserves projected tokens before sending and blocks unknown usage by default", () => {
    const settings = { maxRequests: 0, maxTokens: 100 };
    const reserved = reserveUsage(undefined, settings, "gemini_api", "m", { inputTokens: 30, outputTokens: 20 }, "r1");
    expect(reserved.pending).toMatchObject([{ id: "r1", inputTokens: 30, outputTokens: 20 }]);
    expect(() => reserveUsage(reserved, settings, "gemini_api", "m", { inputTokens: 40, outputTokens: 20 }, "r2")).toThrow("Ngân sách token");
    expect(() => reserveUsage(undefined, settings, "gemini_api", "m", undefined, "r1")).toThrow("ước lượng được");
    const reported = settleUsage(reserved, "gemini_api", "m", { inputTokens: 80, outputTokens: 30, totalTokens: 110 });
    expect(() => reserveUsage(reported, settings, "gemini_api", "m")).toThrow("giới hạn token");
    expect(normalizeUsage(10, 5, 20)).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 20 });
    expect(normalizeUsage(-1, 5)).toBeUndefined();
  });
  it("estimates costs only with current, model-specific user-provided prices from official domains", () => {
    const today = new Date().toISOString().slice(0, 10);
    const price = { provider: "openai_api" as const, model: "model-a", inputUsdPerMillion: 2, outputUsdPerMillion: 4, sourceUrl: "https://developers.openai.com/api/docs/pricing", checkedOn: today };
    const usage = settleUsage(reserveUsage(undefined, { maxRequests: 0, maxTokens: 0 }, "openai_api", "model-a", { inputTokens: 1_000_000, outputTokens: 500_000 }, "cost-1"), "openai_api", "model-a", { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }, "cost-1");
    expect(isValidModelPrice(price)).toBe(true);
    expect(isValidModelPrice({ ...price, sourceUrl: "https://fake.example/pricing" })).toBe(false);
    expect(estimateUsageUsd(usage, [price])).toBe(4);
    expect(estimateUsageUsd(usage, [{ ...price, model: "other" }])).toBeUndefined();
    expect(estimateUsageUsd(usage, [{ ...price, checkedOn: "2020-01-01" }])).toBeUndefined();
    expect(() => reserveUsage(usage, { maxRequests: 0, maxTokens: 0, maxCostUsd: 4, modelPrices: [price] }, "openai_api", "model-a", { inputTokens: 1, outputTokens: 1 }, "next")).toThrow("Ngân sách chi phí");
    expect(() => reserveUsage(usage, { maxRequests: 0, maxTokens: 0, maxCostUsd: 5, modelPrices: [price] }, "anthropic_api", "missing", { inputTokens: 1, outputTokens: 1 }, "next")).toThrow("Không thể ước lượng chi phí");
  });
  it("settles rejected requests, records unknown successful usage, and blocks double spending with pending reservations", () => {
    const price = { provider: "openai_api" as const, model: "m", inputUsdPerMillion: 1, outputUsdPerMillion: 1, sourceUrl: "https://developers.openai.com/api/docs/pricing", checkedOn: new Date().toISOString().slice(0, 10) };
    const settings = { maxRequests: 4, maxTokens: 0, maxCostUsd: 0.0005, modelPrices: [price] };
    const first = reserveUsage(undefined, settings, "openai_api", "m", { inputTokens: 100, outputTokens: 100 }, "a");
    expect(estimatePendingUsageUsd(first)).toBeCloseTo(0.0002);
    const rejected = settleUsage(first, "openai_api", "m", undefined, "a", true);
    expect(rejected.unknownUsageRequests).toBe(0);
    expect(rejected.pending).toHaveLength(0);
    const retry = reserveUsage(rejected, settings, "openai_api", "m", { inputTokens: 100, outputTokens: 100 }, "b");
    const unknown = settleUsage(retry, "openai_api", "m", undefined, "b");
    expect(unknown.unknownUsageRequests).toBe(1);
    expect(estimateUsageUsd(unknown, [price])).toBeUndefined();
    expect(() => reserveUsage(unknown, settings, "openai_api", "m", { inputTokens: 1, outputTokens: 1 }, "c")).toThrow("thiếu usage");
    expect(() => reserveUsage(first, settings, "openai_api", "m", { inputTokens: 201, outputTokens: 100 }, "c")).toThrow("Ngân sách chi phí");
  });

  it("applies the explicit warn-and-continue policy to estimates it cannot verify", () => {
    const settings = { maxRequests: 0, maxTokens: 100, maxCostUsd: 0.01, unknownUsagePolicy: "warn_and_continue" as const, modelPrices: [] };
    const reserved = reserveUsage(undefined, settings, "gemini_api", "m", undefined, "unknown-estimate");
    expect(reserved.pending).toMatchObject([{ id: "unknown-estimate", inputTokens: undefined, outputTokens: undefined, estimatedCostUsd: undefined }]);
    expect(estimateUsageUsd(undefined)).toBe(0);
    expect(estimatePendingUsageUsd(undefined)).toBe(0);
    expect(isValidModelPrice(null)).toBe(false);
  });

  it("settles legacy reservations and fallback accounting without charging unknown usage as zero", () => {
    const legacy = { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsageRequests: 0, byModel: [], pending: [{ id: "legacy", provider: "openai_api" as const, model: "m" }] } as unknown as RunUsage;
    const reserved = reserveUsage(legacy, { maxRequests: 0, maxTokens: 100, unknownUsagePolicy: "warn_and_continue" }, "openai_api", "m", { inputTokens: 1, outputTokens: 1 }, "next");
    const settled = settleUsage(reserved, "openai_api", "m", { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
    expect(settled.totalTokens).toBe(8);
    expect(settled.unknownUsageRequests).toBe(0);
    expect(incrementFallbackCount(settled).fallbackCount).toBe(1);
    const noModelEntry = settleUsage({ ...settled, byModel: [] }, "anthropic_api", "n", { inputTokens: 2, outputTokens: 2, totalTokens: 4 });
    expect(noModelEntry).toMatchObject({ totalTokens: 12, byModel: [] });
  });

  it("tracks each request from reservation through dispatch, completion, and confirmed rejection", () => {
    const settings = { maxRequests: 4, maxTokens: 0 };
    const reserved = reserveUsage(undefined, settings, "openai_api", "m", { inputTokens: 40, outputTokens: 10 }, "attempt-1", Date.now(), "request-1", "q1");
    expect(reserved.pending[0]).toMatchObject({ id: "attempt-1", requestId: "request-1", questionId: "q1", status: "reserved" });
    const dispatching = updateReservationStatus(reserved, "attempt-1", "dispatching");
    const inFlight = updateReservationStatus(dispatching, "attempt-1", "in_flight");
    const completed = settleUsage(inFlight, "openai_api", "m", { inputTokens: 15, outputTokens: 5, totalTokens: 20 }, "attempt-1");
    expect(completed).toMatchObject({ requests: 1, totalTokens: 20, unknownUsageRequests: 0, pending: [] });

    const retry = reserveUsage(completed, settings, "openai_api", "m", { inputTokens: 20, outputTokens: 5 }, "attempt-2", Date.now(), "request-2", "q2");
    const rejected = settleUsage(updateReservationStatus(retry, "attempt-2", "in_flight"), "openai_api", "m", undefined, "attempt-2", true);
    expect(rejected).toMatchObject({ requests: 2, unknownUsageRequests: 0, pending: [] });
    expect(rejected.byModel[0]?.requests).toBe(2);
  });

  it("releases only a proven unsent reservation and preserves unknown usage until an explicit resolution", () => {
    const settings = { maxRequests: 4, maxTokens: 0 };
    const base = reserveUsage(undefined, settings, "gemini_api", "m", { inputTokens: 80, outputTokens: 20 }, "attempt", Date.now(), "logical", "q1");
    const released = releaseUnsentReservation(base, "attempt");
    expect(released).toMatchObject({ requests: 0, unknownUsageRequests: 0, pending: [] });
    expect(released.byModel[0]?.requests).toBe(0);

    const inFlight = updateReservationStatus(base, "attempt", "in_flight");
    const unknown = markUnknownUsage(inFlight, "gemini_api", "m", "attempt", "logical");
    expect(markUnknownUsage(unknown, "gemini_api", "m", "attempt", "logical")).toEqual(unknown);
    expect(unknown).toMatchObject({ requests: 1, unknownUsageRequests: 1, pending: [{ id: "attempt", requestId: "logical", status: "unknown", inputTokens: 80, outputTokens: 20 }] });
    expect(estimateUsageUsd(unknown)).toBeUndefined();

    const heldEstimate = resolveUnknownReservation(unknown, "logical", "count_estimate");
    expect(heldEstimate).toMatchObject({ requests: 1, unknownUsageRequests: 0, pending: [{ status: "estimated", inputTokens: 80, outputTokens: 20 }] });
    const explicitlyNotCharged = resolveUnknownReservation(unknown, "logical", "not_charged");
    expect(explicitlyNotCharged).toMatchObject({ requests: 1, unknownUsageRequests: 0, pending: [] });
    expect(() => resolveUnknownReservation(explicitlyNotCharged, "logical", "not_charged")).toThrow("usage chưa rõ");
  });
});
