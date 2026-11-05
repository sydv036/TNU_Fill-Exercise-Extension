import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionSnapshot, QuizTarget, RuntimeMessage } from "../src/types";
import { reserveUsage as importReserve, updateReservationStatus } from "../src/run-budget";
import { makeMemoryEntry } from "../src/answer-memory";

function area() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]))),
    set: vi.fn(async (value: Record<string, unknown>) => { data = { ...data, ...value }; }),
    remove: vi.fn(async (key: string) => { delete data[key]; }),
    clear: vi.fn(async () => { data = {}; }),
    getBytesInUse: vi.fn(async () => JSON.stringify(data).length),
    setAccessLevel: vi.fn(async () => undefined)
  };
}
const pageUrl = "https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=11&cmid=123";
const target: QuizTarget = { id: "1:123", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=123", courseId: "1", courseName: "Môn", category: "", week: "1", name: "Bài", assessmentKind: "practice", source: "auto" };
const question: QuestionSnapshot = { id: "q1", number: "1", type: "single", prompt: "2+2?", images: [], options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }] };
const ui = { id: "test", url: "chrome-extension://test/sidepanel.html" } as Browser.runtime.MessageSender;
const tnu = { url: pageUrl, tab: { id: 7 } } as Browser.runtime.MessageSender;
let local: ReturnType<typeof area>;
let session: ReturnType<typeof area>;
let requests: string[];
let delayedResponse: Promise<Response> | undefined;
let generateStarted: (() => void) | undefined;
let lastExternalPrompt = "";
let dispatch: typeof import("../entrypoints/background").dispatchMessage;
let getRun: typeof import("../src/storage").getRun;
let getSettings: typeof import("../src/storage").getSettings;
let mutateRun: typeof import("../src/storage").mutateRun;

beforeEach(async () => {
  vi.resetModules();
  local = area(); session = area(); requests = []; delayedResponse = undefined; generateStarted = undefined; lastExternalPrompt = "";
  vi.stubGlobal("defineBackground", (fn: unknown) => fn);
  vi.stubGlobal("browser", {
    runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path.startsWith("/") ? path.slice(1) : path}` },
    storage: { local, session },
    tabs: { get: vi.fn(async () => ({ id: 7, url: pageUrl })), query: vi.fn(async () => [{ id: 7, url: pageUrl }]), sendMessage: vi.fn(async () => ({ ok: true })), update: vi.fn(async () => undefined) }
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    if (url.startsWith("https://api.openai.com/") || url.startsWith("https://api.anthropic.com/")) {
      const anthropic = url.includes("anthropic.com");
      if (url.includes("/models")) return new Response(JSON.stringify({ data: [{ id: anthropic ? "claude-model" : "openai-model" }], has_more: false }));
      const body = JSON.parse(String(init?.body));
      const prompt = anthropic ? body.messages[0].content[0].text : body.input[0].content[0].text;
      lastExternalPrompt = prompt;
      generateStarted?.();
      if (delayedResponse) return delayedResponse;
      const requestId = prompt.match(/Mã yêu cầu: ([\w-]+)/)[1];
      const questionId = prompt.match(/Câu hỏi ID: ([\w-]+)/)[1];
      const value = JSON.stringify({ requestId, questionId, selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false });
      return new Response(JSON.stringify(anthropic ? { stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 8 }, content: [{ type: "text", text: value }] } : { status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: value }] }] }));
    }
    if (url.includes(":generateContent")) {
      generateStarted?.();
      if (delayedResponse) return delayedResponse;
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false }) }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ models: ["a", "b"].map((id) => ({ name: `models/gemini-${id}`, supportedGenerationMethods: ["generateContent"] })) }), { status: 200 });
  }));
  ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
  ({ getRun, getSettings, mutateRun } = await import("../src/storage"));
});

const call = (message: RuntimeMessage, sender = ui) => dispatch(message, sender);
async function setKey(provider: "gemini_api" | "openai_api" | "anthropic_api", value: string) {
  const { token } = (await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider })).data as { token: string };
  const key = provider === "gemini_api" ? "geminiApiKey" : provider === "openai_api" ? "openaiApiKey" : "anthropicApiKey";
  await local.set({ [key]: value });
  await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider, token });
}
const start = () => call({ type: "START_RUN", target, mode: "from_current", memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: [], tnuTabId: 7 });
const setPending = async (runId: string, executionEpoch: string, decision: import("../src/types").AnswerDecision) => call({ type: "UPDATE_RUN", runId, executionEpoch, patch: { status: "awaiting_user", currentQuestionSnapshot: question, pendingDecision: { question, decision } } }, tnu);

describe("provider switching through background and storage", () => {
  it("persists SCORM controls and restores the latest frame status", async () => {
    await call({ type: "SCORM_CONTROL", settings: { scormEnabled: true, scormPlaybackRate: 8, scormAutoNext: true, scormNextDelayMs: 750, scormPauseOnInteraction: true } });
    expect(await getSettings()).toMatchObject({ scormEnabled: true, scormPlaybackRate: 8, scormAutoNext: true, scormNextDelayMs: 750 });
    const frameUrl = "https://tnu.aum.edu.vn/pluginfile.php/1/mod_scorm/content/1/res/index.html";
    await call({ type: "SCORM_STATUS_UPDATE", status: { frameUrl, detected: true, enabled: true, state: "playing", playbackRate: 8, mediaKind: "audio", currentTime: 2, duration: 20, message: "Đang phát ở 8×.", updatedAt: new Date().toISOString() } }, { url: frameUrl, tab: { id: 7 } } as Browser.runtime.MessageSender);
    const state = await call({ type: "GET_STATE" });
    expect((state.data as import("../src/types").AppState).scormStatus).toMatchObject({ tabId: 7, state: "playing", playbackRate: 8 });
  });
  it("keeps credentials out of TNU state and prevents TNU from changing keys", async () => {
    await setKey("openai_api", "isolated-secret");
    await expect(call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "anthropic_api" }, tnu)).rejects.toThrow("Trang TNU");
    const state = await call({ type: "GET_STATE" }, tnu);
    expect(JSON.stringify(state)).not.toContain("isolated-secret");
    expect((await local.get("anthropicApiKey")).anthropicApiKey).toBeUndefined();
  });
  it("keeps a key-change lease across worker restart and blocks API work until commit", async () => {
    const begin = await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "gemini_api" });
    const token = (begin.data as { token: string }).token;
    await local.set({ geminiApiKey: "restart-secret" });
    const hostileSender = { url: "https://evil.example/page" } as Browser.runtime.MessageSender;
    await expect(call({ type: "SAVE_SETTINGS", settings: await getSettings() }, hostileSender)).rejects.toThrow("Nguồn thông điệp");
    vi.resetModules();
    ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
    ({ getRun, getSettings, mutateRun } = await import("../src/storage"));
    await expect(start()).rejects.toThrow("Đang thay API key");
    await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider: "gemini_api", token });
    expect((await local.get("modelCapabilities")).modelCapabilities).toEqual([]);
    await start();
    expect((await getRun())?.status).toBe("preparing");
  });
  it("probes a chosen model with synthetic text and image without leaking keys", async () => {
    await setKey("openai_api", "openai-only-secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    const baseFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return baseFetch(input, init); }));
    const text = await call({ type: "TEST_API_CAPABILITY", provider: "openai_api", image: false });
    const image = await call({ type: "TEST_API_CAPABILITY", provider: "openai_api", image: true });
    expect(text.data).toMatchObject({ model: "openai-model", image: false, schemaValid: true, answerMatchesFixture: true });
    expect(image.data).toMatchObject({ image: true, answerMatchesFixture: true });
    expect(JSON.stringify(image)).not.toContain("openai-only-secret");
    const sent = calls.filter((item) => item.url.endsWith("/responses"));
    expect(sent).toHaveLength(2);
    expect(JSON.parse(String(sent[1]!.init?.body)).input[0].content[1].type).toBe("input_image");
    expect((sent[1]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer openai-only-secret");
    expect((await call({ type: "GET_STATE" })).data).toMatchObject({ modelCapabilities: [{ provider: "openai_api", model: "openai-model", textVerifiedAt: expect.any(String), imageVerifiedAt: expect.any(String) }] });
    await setKey("openai_api", "replacement-secret");
    expect((await call({ type: "GET_STATE" })).data).toMatchObject({ modelCapabilities: [] });
    await expect(call({ type: "TEST_API_CAPABILITY", provider: "openai_api", image: false }, tnu)).rejects.toThrow("không được phép");
  });

  it.each([["gemini_api", "openai_api"], ["openai_api", "anthropic_api"]] as const)("falls back only after a confirmed 429: %s to %s", async (primary, fallback) => {
    await setKey("gemini_api", "gemini-key");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    for (const provider of ["openai_api", "anthropic_api"] as const) {
      await setKey(provider, `${provider}-secret`);
      await call({ type: "SELECT_PROVIDER_MODEL", provider, model: provider === "openai_api" ? "openai-model" : "claude-model" });
    }
    await local.set({ modelCapabilities: [{ provider: fallback, model: fallback === "openai_api" ? "openai-model" : "claude-model", textVerifiedAt: new Date().toISOString() }] });
    const current = await getSettings();
    await call({ type: "SAVE_SETTINGS", settings: { ...current, retryCount: 0, fallbackEnabled: true, fallbackOrder: primary === "gemini_api" ? ["openai_api", "gemini_api", "anthropic_api"] : ["anthropic_api", "openai_api", "gemini_api"], fallbackMax: 1 } });
    if (primary !== "gemini_api") await call({ type: "SWITCH_PROVIDER", provider: primary });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (primary === "gemini_api" ? url.includes(":generateContent") : url.endsWith("/responses")) return new Response(JSON.stringify(primary === "gemini_api" ? { error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } } : { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), { status: 429 });
      return baseFetch(input, init);
    }));
    await start();
    const run = (await getRun())!;
    const response = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    expect(response.data).toMatchObject({ source: fallback === "openai_api" ? "openai" : "anthropic", selectedOptionIds: ["option_1"] });
    expect(await getRun()).toMatchObject({ provider: primary, activeExecution: { providerId: fallback, status: "completed" }, usage: { requests: 2 } });
  });

  it("stops at the request budget before sending a second question", async () => {
    await setKey("openai_api", "secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), maxRequests: 1 } });
    await start();
    const run = (await getRun())!;
    await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    const before = requests.filter((url) => url.endsWith("/responses")).length;
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question: { ...question, id: "q2" } }, tnu)).rejects.toThrow("giới hạn số yêu cầu");
    expect(requests.filter((url) => url.endsWith("/responses"))).toHaveLength(before);
  });
  it("blocks before API dispatch when projected spending exceeds the session limit", async () => {
    await setKey("openai_api", "secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    const price = { provider: "openai_api" as const, model: "openai-model", inputUsdPerMillion: 1, outputUsdPerMillion: 1, checkedOn: new Date().toISOString().slice(0, 10), sourceUrl: "https://developers.openai.com/api/docs/pricing" };
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), modelPrices: [price], maxCostUsd: 0.00001 } });
    await start();
    const run = (await getRun())!;
    const before = requests.filter((url) => url.endsWith("/responses")).length;
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("Ngân sách chi phí ước tính không đủ");
    expect(requests.filter((url) => url.endsWith("/responses"))).toHaveLength(before);
    expect((await getRun())?.usage).toBeUndefined();
  });
  it("serializes concurrent budget reservations so only one projected request can fit", async () => {
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), maxRequests: 5, maxTokens: 100 } });
    await start();
    const run = (await getRun())!;
    const reserve = (id: string) => mutateRun((current) => current?.id === run.id ? {
      ...current,
      usage: importReserve(current.usage, current.settingsSnapshot!, "openai_api", "openai-model", { inputTokens: 50, outputTokens: 50 }, id)
    } : undefined);
    const results = await Promise.allSettled([reserve("race-a"), reserve("race-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getRun())?.usage).toMatchObject({ requests: 1, pending: [{ inputTokens: 50, outputTokens: 50 }] });
    expect(requests.filter((url) => url.endsWith("/responses"))).toHaveLength(0);
  });

  it("does not fall back on an uncertain server error", async () => {
    await setKey("openai_api", "secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), retryCount: 0, fallbackEnabled: true } });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/responses") ? new Response("{}", { status: 500 }) : baseFetch(input, init)));
    await start();
    const run = (await getRun())!;
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("500");
    expect((await getRun())?.usage?.requests).toBe(1);
    expect((await getRun())).toMatchObject({ status: "paused", activeExecution: undefined, usage: { unknownUsageRequests: 1, pending: [{ status: "unknown", provider: "openai_api" }] } });
  });
  it("recovers an in-flight request after a worker restart without releasing or duplicating its reservation", async () => {
    await setKey("openai_api", "secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await start();
    const run = (await getRun())!;
    const reservation = "restart-reservation";
    await mutateRun((current) => current?.id === run.id ? {
      ...current,
      activeExecution: { requestId: "restart-request", executionEpoch: run.executionEpoch!, questionId: question.id, providerId: "openai_api", modelId: "openai-model", status: "waiting" },
      usage: updateReservationStatus(importReserve(current.usage, current.settingsSnapshot!, "openai_api", "openai-model", { inputTokens: 100, outputTokens: 50 }, reservation, Date.now(), "restart-request", question.id), reservation, "in_flight")
    } : undefined);
    const checkpoints = await import("../src/request-checkpoint");
    const checkpoint = await checkpoints.beginCheckpoint(run.id, question.id, { requestId: "restart-request", executionEpoch: run.executionEpoch!, providerId: "openai_api", modelId: "openai-model" });
    await checkpoints.updateCheckpoint(checkpoint.requestId, "reserved", { reservationId: reservation });
    await checkpoints.updateCheckpoint(checkpoint.requestId, "dispatching");
    await checkpoints.updateCheckpoint(checkpoint.requestId, "in_flight");

    vi.resetModules();
    ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
    ({ getRun, getSettings, mutateRun } = await import("../src/storage"));
    await call({ type: "GET_STATE" });
    const recovered = (await getRun())!;
    expect(recovered).toMatchObject({ status: "paused", usage: { requests: 1, unknownUsageRequests: 1, pending: [{ id: reservation, requestId: "restart-request", questionId: "q1", status: "unknown" }] } });
    await expect(call({ type: "RESUME_RUN" })).rejects.toThrow("usage");
    await call({ type: "RESOLVE_UNKNOWN_USAGE", requestId: "restart-request", resolution: "count_estimate" });
    expect((await getRun())?.processedQuestionIds).toContain(question.id);
    expect((await getRun())?.usage).toMatchObject({ requests: 1, unknownUsageRequests: 0, pending: [{ id: reservation, status: "estimated" }] });
    await call({ type: "RESUME_RUN" });
    expect((await getRun())?.processedQuestionIds).toContain(question.id);
  });
  it("does not dispatch when persisting the budget reservation fails and leaves the run recoverable", async () => {
    await setKey("openai_api", "secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await start();
    const run = (await getRun())!;
    const originalSet = session.set.getMockImplementation()!;
    let writes = 0;
    session.set.mockImplementation(async (value) => {
      writes++;
      if (writes === 3) throw new Error("session storage unavailable");
      return originalSet(value);
    });
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("session storage unavailable");
    expect(requests.filter((url) => url.endsWith("/responses"))).toHaveLength(0);
    const checkpoint = await (await import("../src/request-checkpoint")).getCheckpoint();
    expect(checkpoint).toBeUndefined();
    expect((await getRun())).toMatchObject({ status: "paused", activeExecution: undefined });
    await call({ type: "RESUME_RUN" });
    expect((await getRun())?.status).toBe("answering");
  });
  it("does not retry or fall back for prepaid-credit or spend-limit 429 errors", async () => {
    await setKey("openai_api", "openai-key");
    await setKey("anthropic_api", "claude-key");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "anthropic_api", model: "claude-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), retryCount: 2, fallbackEnabled: true, fallbackOrder: ["anthropic_api", "openai_api", "gemini_api"], fallbackMax: 1 } });
    await local.set({ modelCapabilities: [{ provider: "anthropic_api", model: "claude-model", textVerifiedAt: new Date().toISOString() }] });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/responses")
      ? new Response(JSON.stringify({ error: { message: "private account detail", type: "insufficient_quota", code: "credit_balance_exhausted" } }), { status: 429 })
      : String(input).includes("api.anthropic.com") ? new Response(JSON.stringify({ data: [{ id: "claude-model" }], has_more: false })) : new Response(JSON.stringify({ data: [{ id: "openai-model" }] }))));
    await start();
    const run = (await getRun())!;
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("bổ sung tín dụng");
    expect((await getRun())?.usage).toMatchObject({ requests: 1, pending: [], unknownUsageRequests: 0, fallbackCount: 0 });
  });
  it("does not send the fallback request after Stop during model discovery", async () => {
    for (const provider of ["openai_api", "anthropic_api"] as const) {
      await setKey(provider, "fixture-key");
      await call({ type: "SELECT_PROVIDER_MODEL", provider, model: provider === "openai_api" ? "openai-model" : "claude-model" });
    }
    await local.set({ modelCapabilities: [{ provider: "anthropic_api", model: "claude-model", textVerifiedAt: new Date().toISOString() }] });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), retryCount: 0, fallbackEnabled: true, fallbackOrder: ["anthropic_api", "openai_api", "gemini_api"], fallbackMax: 1 } });
    const baseFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    let notify!: () => void;
    const waiting = new Promise<void>((resolve) => { notify = resolve; });
    const blocked = new Promise<Response>((resolve) => { release = resolve; });
    let fallbackPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/responses")) return new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }), { status: 429 });
      if (url.startsWith("https://api.anthropic.com/") && url.includes("/models")) { notify(); return blocked; }
      if (url.endsWith("/messages")) fallbackPosts++;
      return baseFetch(input, init);
    }));
    await start();
    const run = (await getRun())!;
    const result = call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu).then(() => "accepted", () => "rejected");
    await waiting;
    await call({ type: "STOP_RUN" });
    release(new Response(JSON.stringify({ data: [{ id: "claude-model" }], has_more: false })));
    expect(await result).toBe("rejected");
    expect(fallbackPosts).toBe(0);
    expect((await getRun())?.status).toBe("paused");
  });
  it("sends selected documents on a practice run without forcing manual review", async () => {
    const material = { id: "doc", courseId: "1", courseName: "Môn", week: "1", name: "Phép cộng", url: "https://tnu.aum.edu.vn/doc.pdf", kind: "slide" };
    await local.set({ knowledgeIndexes: { "1": { courseId: "1", courseName: "Môn", indexedAt: "now", materials: [material], chunks: [{ id: "chunk", courseId: "1", materialId: "doc", materialName: material.name, materialUrl: material.url, week: "1", kind: "slide", text: "Phép cộng cho kết quả bốn." }], failedMaterials: [] } } });
    await setKey("openai_api", "fixture-key");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await call({ type: "START_RUN", target, mode: "from_current", memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: ["doc"], tnuTabId: 7 });
    const run = (await getRun())!;
    expect(run.reviewEveryAnswer).toBe(false);
    const result = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question: { ...question, prompt: "Phép cộng 2+2?" } }, tnu);
    expect(result.data).toMatchObject({ source: "openai" });
    expect(lastExternalPrompt).toContain("Phép cộng cho kết quả bốn.");
  });
  it("stores review answers even when the run is paused and an earlier empty capture marked the page", async () => {
    await start();
    const run = (await getRun())!;
    await mutateRun((current) => current?.id === run.id ? { ...current, status: "paused" } : undefined);
    const reviewUrl = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=11&cmid=123";
    await session.set({ reviewCaptures: { [reviewUrl]: true } });
    const entry = makeMemoryEntry(target, question, ["4"], reviewUrl);
    const result = await call({ type: "SAVE_REVIEW_ANSWERS", runId: run.id, executionEpoch: run.executionEpoch!, target, entries: [entry], sourceUrl: reviewUrl, reviewComplete: true }, { url: reviewUrl, tab: { id: 7 } } as Browser.runtime.MessageSender);
    const { getAnswerMemory } = await import("../src/storage");
    expect(result.data).toMatchObject({ saved: 1 });
    expect(await getAnswerMemory()).toHaveLength(1);
    expect((await getRun())?.message).toContain("Đã lưu 1 đáp án đúng");
  });
  it("stores review answers when no active run survives the review page", async () => {
    const reviewUrl = "https://tnu.aum.edu.vn/mod/quiz/review.php?attempt=12&cmid=123";
    const entry = makeMemoryEntry(target, question, ["4"], reviewUrl);
    const result = await call({ type: "SAVE_REVIEW_ANSWERS", target, entries: [entry], sourceUrl: reviewUrl, reviewComplete: true }, { url: reviewUrl, tab: { id: 7 } } as Browser.runtime.MessageSender);
    const { getAnswerMemory } = await import("../src/storage");
    expect(result.data).toMatchObject({ saved: 1, total: 1 });
    expect(await getAnswerMemory()).toHaveLength(1);
  });
  it("rejects a late OpenAI response after stop and switch to Claude", async () => {
    for (const provider of ["openai_api", "anthropic_api"] as const) {
      await setKey(provider, "fixture-key");
      await call({ type: "SELECT_PROVIDER_MODEL", provider, model: provider === "openai_api" ? "openai-model" : "claude-model" });
    }
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await start();
    const old = (await getRun())!;
    let release!: (response: Response) => void;
    delayedResponse = new Promise<Response>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { generateStarted = resolve; });
    const pending = call({ type: "ANSWER_QUESTION", runId: old.id, executionEpoch: old.executionEpoch!, question }, tnu).then(() => "accepted", () => "rejected");
    await started;
    const requestId = lastExternalPrompt.match(/Mã yêu cầu: ([\w-]+)/)![1];
    await call({ type: "STOP_RUN" });
    await call({ type: "SWITCH_PROVIDER", provider: "anthropic_api" });
    await expect(call({ type: "RESUME_RUN" })).rejects.toThrow("usage");
    const usage = (await getRun())?.usage?.pending.find((item) => item.status === "unknown");
    expect(usage?.requestId).toBeTruthy();
    await call({ type: "RESOLVE_UNKNOWN_USAGE", requestId: usage!.requestId!, resolution: "not_charged" });
    await call({ type: "RESUME_RUN" });
    delayedResponse = undefined;
    const current = (await getRun())!;
    const fresh = await call({ type: "ANSWER_QUESTION", runId: current.id, executionEpoch: current.executionEpoch!, question }, tnu);
    expect(fresh.data).toMatchObject({ source: "anthropic" });
    const value = JSON.stringify({ requestId, questionId: "q1", selectedOptionIds: ["option_0"], confidence: 0.9, reason: "old", needsHumanReview: false });
    release(new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: value }] }] })));
    expect(await pending).toBe("rejected");
    expect((await getRun())?.provider).toBe("anthropic_api");
  });
  it("invalidates the active epoch when the TNU tab reloads and rejects its late answer", async () => {
    await setKey("openai_api", "fixture-key");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await start();
    const run = (await getRun())!;
    let release!: (response: Response) => void;
    delayedResponse = new Promise<Response>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { generateStarted = resolve; });
    const result = call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu).then(() => "accepted", () => "rejected");
    await started;
    const oldId = lastExternalPrompt.match(/Mã yêu cầu: ([\w-]+)/)?.[1];
    const { handleTnuTabLifecycleEvent } = await import("../entrypoints/background");
    await handleTnuTabLifecycleEvent(7, "reloaded");
    const paused = (await getRun())!;
    expect(paused).toMatchObject({ status: "paused", usage: { unknownUsageRequests: 1, pending: [{ status: "unknown", requestId: oldId }] } });
    release(new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ requestId: oldId, questionId: "q1", selectedOptionIds: ["option_1"], confidence: 0.9, reason: "late", needsHumanReview: false }) }] }] })));
    expect(await result).toBe("rejected");
    const afterLateResponse = (await getRun())!;
    expect(afterLateResponse).toMatchObject({ status: "paused", executionEpoch: paused.executionEpoch });
    expect(afterLateResponse.pendingDecision).toBeUndefined();
  });
  it("runs OpenAI then switches to Claude after stop and recovers settings after worker restart", async () => {
    await setKey("gemini_api", "gemini-secret");
    await setKey("openai_api", "openai-secret");
    await setKey("anthropic_api", "claude-secret");
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "openai-model" });
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "anthropic_api", model: "claude-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    await start();
    const run = (await getRun())!;
    const first = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    expect(first.data).toMatchObject({ source: "openai", selectedOptionIds: ["option_1"] });
    await expect(call({ type: "SWITCH_PROVIDER", provider: "anthropic_api" })).rejects.toThrow("dừng phiên");
    await call({ type: "STOP_RUN" });
    vi.resetModules();
    ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
    ({ getRun, getSettings } = await import("../src/storage"));
    await call({ type: "SWITCH_PROVIDER", provider: "anthropic_api" });
    await call({ type: "RESUME_RUN" });
    const resumed = (await getRun())!;
    expect(resumed).toMatchObject({ provider: "anthropic_api", settingsSnapshot: { openaiModel: "openai-model", anthropicModel: "claude-model" } });
    await expect(call({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "completed" } }, tnu)).rejects.toThrow();
    const second = await call({ type: "ANSWER_QUESTION", runId: resumed.id, executionEpoch: resumed.executionEpoch!, question: { ...question, id: "q2" } }, tnu);
    expect(second.data).toMatchObject({ source: "anthropic", selectedOptionIds: ["option_1"] });
    expect(await local.get(["geminiApiKey", "openaiApiKey", "anthropicApiKey"])).toMatchObject({ geminiApiKey: "gemini-secret", openaiApiKey: "openai-secret", anthropicApiKey: "claude-secret" });
  });
  it("stops a manual request, switches to Gemini API, preserves settings and rejects the old response", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    await call({ type: "SAVE_SETTINGS", settings: { ...await getSettings(), manualPrompt: "prompt cần giữ", cacheMode: "ai", documentLimit: 8 } });
    await local.set({ answerMemory: [{ keep: "cache" }], knowledgeIndexes: { keep: "documents" } });
    await start();
    const run = (await getRun())!;
    const answer = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    const decision = answer.data as import("../src/types").AnswerDecision;
    await setPending(run.id, run.executionEpoch!, decision);
    await call({ type: "STOP_RUN" });
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-b" });
    await call({ type: "SWITCH_PROVIDER", provider: "gemini_api" });
    await expect(call({ type: "SUBMIT_MANUAL_RESPONSE", runId: run.id, questionId: question.id, requestId: decision.manualRequestId!, response: "{}", imagesAttached: false, newChatConfirmed: true })).rejects.toThrow();
    await call({ type: "RESUME_RUN" });
    const resumed = (await getRun())!;
    expect(resumed).toMatchObject({ id: run.id, provider: "gemini_api", settingsSnapshot: { model: "gemini-b" }, currentQuestionSnapshot: { id: "q1" } });
    expect(resumed.settingsSnapshot).toMatchObject({ manualPrompt: "prompt cần giữ", cacheMode: "ai", documentLimit: 8 });
    expect(resumed.executionEpoch).not.toBe(run.executionEpoch);
    expect(resumed.pendingDecision).toBeUndefined();
    await expect(call({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "completed" } }, tnu)).rejects.toThrow();
    const result = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: resumed.executionEpoch!, question }, tnu);
    expect(result.data).toMatchObject({ selectedOptionIds: ["option_1"], source: "gemini" });
    expect(requests.some((url) => url.includes("gemini-b:generateContent"))).toBe(true);
    expect((await local.get(["geminiApiKey", "answerMemory", "knowledgeIndexes"]))).toMatchObject({ geminiApiKey: "secret", answerMemory: [{ keep: "cache" }], knowledgeIndexes: { keep: "documents" } });
  });

  it("blocks unknown delivery and rejects a late API response after switching", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await start();
    const run = (await getRun())!;
    let resolveFetch!: (response: Response) => void;
    delayedResponse = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const started = new Promise<void>((resolve) => { generateStarted = resolve; });
    const oldResult = call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu).then(() => "accepted", () => "rejected");
    await started;
    await call({ type: "STOP_RUN" });
    await call({ type: "SWITCH_PROVIDER", provider: "claude_manual" });
    await expect(call({ type: "RESUME_RUN" })).rejects.toThrow("usage");
    const pendingUsage = (await getRun())?.usage?.pending.find((item) => item.status === "unknown");
    await call({ type: "RESOLVE_UNKNOWN_USAGE", requestId: pendingUsage!.requestId!, resolution: "not_charged" });
    await call({ type: "RESUME_RUN" });
    const resumed = (await getRun())!;
    const nextAnswer = await call({ type: "ANSWER_QUESTION", runId: resumed.id, executionEpoch: resumed.executionEpoch!, question }, tnu);
    const nextDecision = nextAnswer.data as import("../src/types").AnswerDecision;
    await setPending(resumed.id, resumed.executionEpoch!, nextDecision);
    resolveFetch(new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 1, reason: "late", needsHumanReview: false }) }] } }] }), { status: 200 }));
    expect(await oldResult).toBe("rejected");
    expect((await getRun())).toMatchObject({ provider: "claude_manual", executionEpoch: resumed.executionEpoch, status: "awaiting_user", manualConversationCount: 0, pendingDecision: { decision: { manualRequestId: nextDecision.manualRequestId } } });
  });

  it("rejects invalid models and running switches, and restores selection after a worker restart", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await expect(call({ type: "SELECT_GEMINI_MODEL", model: "removed" })).rejects.toThrow("không khả dụng");
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    await start();
    await expect(call({ type: "SWITCH_PROVIDER", provider: "claude_manual" })).rejects.toThrow("dừng phiên");
    await call({ type: "STOP_RUN" });
    vi.resetModules();
    ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
    ({ getRun, getSettings } = await import("../src/storage"));
    await call({ type: "SWITCH_PROVIDER", provider: "gemini_web_manual" });
    await call({ type: "SWITCH_PROVIDER", provider: "claude_manual" });
    await call({ type: "SWITCH_PROVIDER", provider: "gemini_api" });
    await call({ type: "RESUME_RUN" });
    expect(await getRun()).toMatchObject({ provider: "gemini_api", settingsSnapshot: { model: "gemini-a" } });
    expect((await local.get("geminiApiKey")).geminiApiKey).toBe("secret");
  });

  it("uses model B after stopping model A without replaying the completed question", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await start();
    const first = (await getRun())!;
    await call({ type: "ANSWER_QUESTION", runId: first.id, executionEpoch: first.executionEpoch!, question }, tnu);
    await call({ type: "UPDATE_RUN", runId: first.id, executionEpoch: first.executionEpoch, patch: { processedQuestionIds: [question.id] } }, tnu);
    await call({ type: "STOP_RUN" });
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-b" });
    await call({ type: "RESUME_RUN" });
    const resumed = (await getRun())!;
    expect(resumed.processedQuestionIds).toContain(question.id);
    expect(resumed.settingsSnapshot?.model).toBe("gemini-b");
    await call({ type: "ANSWER_QUESTION", runId: resumed.id, executionEpoch: resumed.executionEpoch!, question: { ...question, id: "q2" } }, tnu);
    expect(requests.filter((url) => url.includes(":generateContent"))).toEqual(expect.arrayContaining([expect.stringContaining("gemini-a:"), expect.stringContaining("gemini-b:")]));
  });

  it("serializes switches and keeps the old selection if storage fails", async () => {
    await Promise.all([call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" }), call({ type: "SWITCH_PROVIDER", provider: "claude_manual" })]);
    expect((await local.get("settings")).settings).toMatchObject({ provider: "claude_manual" });
    local.set.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(call({ type: "SWITCH_PROVIDER", provider: "gemini_web_manual" })).rejects.toThrow("storage unavailable");
    expect((await local.get("settings")).settings).toMatchObject({ provider: "claude_manual" });
    await call({ type: "SWITCH_PROVIDER", provider: "gemini_web_manual" });
    expect((await local.get("settings")).settings).toMatchObject({ provider: "gemini_web_manual" });
  });

  it("keeps selection unlocked when the TNU tab disappears during resume", async () => {
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    await start();
    await call({ type: "STOP_RUN" });
    vi.mocked(browser.tabs.get).mockRejectedValueOnce(new Error("tab closed"));
    await expect(call({ type: "RESUME_RUN" })).rejects.toThrow("Tab TNU");
    expect((await getRun())?.status).toBe("paused");
    await call({ type: "SWITCH_PROVIDER", provider: "claude_manual" });
    expect((await local.get("settings")).settings).toMatchObject({ provider: "claude_manual" });
  });

  it("keeps the web selection when Gemini discovery fails and allows another switch", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(call({ type: "SWITCH_PROVIDER", provider: "gemini_api" })).rejects.toThrow("503");
    expect((await local.get("settings")).settings).toMatchObject({ provider: "chatgpt_manual", model: "gemini-a" });
    await call({ type: "SWITCH_PROVIDER", provider: "claude_manual" });
    expect((await local.get("settings")).settings).toMatchObject({ provider: "claude_manual", model: "gemini-a" });
  });

  it("records request identity and prevents a second dispatch of the same question", async () => {
    await setKey("gemini_api", "secret");
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-a" });
    await start();
    const run = (await getRun())!;
    const answer = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    const decision = answer.data as import("../src/types").AnswerDecision;
    expect((await getRun())?.activeExecution).toMatchObject({ requestId: decision.executionRequestId, executionEpoch: run.executionEpoch, questionId: question.id, providerId: "gemini_api", modelId: "gemini-a", status: "completed" });
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("đã được xử lý");
    expect(requests.filter((url) => url.includes(":generateContent"))).toHaveLength(1);
  });

  it("retains the in-flight request lock through a worker restart", async () => {
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    await start();
    const run = (await getRun())!;
    const first = await call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu);
    const firstDecision = first.data as import("../src/types").AnswerDecision;
    vi.resetModules();
    ({ dispatchMessage: dispatch } = await import("../entrypoints/background"));
    ({ getRun } = await import("../src/storage"));
    await expect(call({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch!, question }, tnu)).rejects.toThrow("đang có yêu cầu");
    await call({ type: "STOP_RUN" });
    await call({ type: "RESUME_RUN" });
    const resumed = (await getRun())!;
    const second = await call({ type: "ANSWER_QUESTION", runId: resumed.id, executionEpoch: resumed.executionEpoch!, question }, tnu);
    const secondDecision = second.data as import("../src/types").AnswerDecision;
    expect(secondDecision.manualRequestId).not.toBe(firstDecision.manualRequestId);
    await setPending(resumed.id, resumed.executionEpoch!, secondDecision);
    await expect(call({ type: "SUBMIT_MANUAL_RESPONSE", runId: resumed.id, questionId: question.id, requestId: firstDecision.manualRequestId!, response: "{}", imagesAttached: false, newChatConfirmed: true })).rejects.toThrow("không còn hiệu lực");
    expect((await getRun())?.manualConversationCount).toBe(0);
  });

  it("does not create two manual executions for simultaneous requests", async () => {
    await call({ type: "SWITCH_PROVIDER", provider: "chatgpt_manual" });
    await start();
    const run = (await getRun())!;
    const message = { type: "ANSWER_QUESTION" as const, runId: run.id, executionEpoch: run.executionEpoch!, question };
    const results = await Promise.allSettled([call(message, tnu), call(message, tnu)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await getRun())?.activeExecution).toMatchObject({ questionId: question.id, providerId: "chatgpt_manual", status: "waiting" });
  });
});
