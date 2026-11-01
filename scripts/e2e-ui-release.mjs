import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || "release/v3.3.1/chrome-mv3");
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = await mkdtemp(path.join(tmpdir(), "tnu-ui-release-e2e-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__failNextGeminiModels = false;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected network call in UI fixture: ${url}`);
      if (url.includes(":generateContent")) return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.95, reason: "Gemini UI fixture", needsHumanReview: false }) }] } }] }));
      if (globalThis.__failNextGeminiModels) {
        globalThis.__failNextGeminiModels = false;
        return new Response(JSON.stringify({ error: { message: "fixture service unavailable" } }), { status: 503 });
      }
      return new Response(JSON.stringify({ models: [{ name: "models/fixture-gemini", displayName: "Fixture Gemini", supportedGenerationMethods: ["generateContent"] }, { name: "models/fixture-other", displayName: "Fixture Other", supportedGenerationMethods: ["generateContent"] }] }));
    };
    void chrome.storage.local.set({ openaiApiKey: "legacy-key-preserved", anthropicApiKey: "legacy-key-preserved" });
  });

  let panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator("nav").getByRole("button", { name: /AI/ }).click();
  await panel.getByText(/ChatGPT Web — READY/).waitFor();
  await panel.getByText(/Claude Web — READY/).waitFor();
  await panel.getByText(/Gemini Web — READY/).waitFor();
  const webPanel = panel.locator(".panel-card").filter({ hasText: "AI Web" }).first();
  if (await webPanel.locator("input").count()) throw new Error("AI Web section asks for an API key.");
  if (await panel.getByLabel("OpenAI API key").count() || await panel.getByLabel("Claude API key").count()) throw new Error("OpenAI/Claude API key inputs are still shown in the primary provider UI.");

  const gemini = panel.locator(".panel-card").filter({ hasText: "Gemini API key" });
  const geminiModel = panel.locator(".panel-card").filter({ hasText: "Model hỗ trợ generateContent" });
  await gemini.getByLabel("Gemini API key").fill("fixture-gemini-key");
  await gemini.getByRole("button", { name: "Lưu", exact: true }).click();
  await panel.getByText("Đã lưu key và tải danh sách model.").waitFor({ timeout: 10000 });
  await geminiModel.getByLabel("Model Gemini API").selectOption("fixture-gemini");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.model === "fixture-gemini");
  await worker.evaluate(() => { globalThis.__failNextGeminiModels = true; });
  await geminiModel.getByRole("button", { name: /Làm mới/ }).click();
  await panel.locator(".error-box").getByText(/Gemini API lỗi HTTP 503/, { exact: false }).waitFor({ timeout: 10000 });
  await geminiModel.getByRole("button", { name: /Làm mới/ }).click();
  await geminiModel.getByRole("option", { name: /Fixture Gemini/ }).waitFor({ state: "attached", timeout: 10000 });
  await panel.getByRole("button", { name: "Thử text thật" }).click();
  await panel.getByText(/đã xác minh/, { exact: false }).waitFor({ timeout: 10000 });
  await worker.evaluate(async () => {
    const expired = new Date(Date.now() - 31 * 86400000).toISOString();
    await chrome.storage.local.set({ modelCapabilities: [{ provider: "gemini_api", model: "fixture-gemini", textVerifiedAt: expired, imageVerifiedAt: expired }] });
  });
  await panel.locator("main").getByText(/đã hết hạn \(30 ngày\)/, { exact: false }).first().waitFor({ timeout: 10000 });
  await geminiModel.getByLabel("Model Gemini API").selectOption("fixture-other");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.model === "fixture-other");
  await geminiModel.getByLabel("Model Gemini API").selectOption("fixture-gemini");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.model === "fixture-gemini");

  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  const provider = panel.getByLabel("AI provider");
  const providerOptions = await provider.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent })));
  for (const expected of ["chatgpt_web", "claude_web", "gemini_web", "deepseek_web", "gemini_api"]) if (!providerOptions.some((option) => option.value === expected)) throw new Error(`Missing primary provider ${expected}.`);
  if (providerOptions.some((option) => ["openai_api", "anthropic_api"].includes(option.value) && !option.disabled)) throw new Error("Legacy OpenAI/Claude API provider is still enabled in the primary selector.");
  await provider.selectOption("gemini_api");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.provider === "gemini_api");
  await panel.close();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  if (await panel.getByLabel("AI provider").inputValue() !== "gemini_api") throw new Error("Provider selection did not survive sidepanel reopen.");
  await panel.locator("nav").getByRole("button", { name: /AI/ }).click();
  const reopened = panel.locator(".panel-card").filter({ hasText: "Model hỗ trợ generateContent" });
  if (await reopened.getByLabel("Model Gemini API").inputValue() !== "fixture-gemini") throw new Error("Gemini model selection did not survive sidepanel reopen.");
  const preservedKeys = await panel.evaluate(async () => chrome.storage.local.get(["openaiApiKey", "anthropicApiKey"]));
  if (preservedKeys.openaiApiKey !== "legacy-key-preserved" || preservedKeys.anthropicApiKey !== "legacy-key-preserved") throw new Error("V3 removed legacy API keys from local storage.");

  const tnu = await context.newPage();
  await tnu.route("https://tnu.aum.edu.vn/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<form id="responseform"><div class="que" id="q1"><div class="qtext">Fixture</div><div class="answer"><label><input type="radio" name="q">3</label><label><input type="radio" name="q">4</label></div></div></form>' }));
  await tnu.goto("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=1&cmid=1");
  const tabId = await panel.evaluate(async () => (await chrome.tabs.query({ url: "https://tnu.aum.edu.vn/*" }))[0].id);
  await panel.evaluate(async (tnuTabId) => {
    const state = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data;
    const run = {
      id: "ui-unknown-run", executionEpoch: "ui-epoch", tnuTabId, provider: "gemini_api", settingsSnapshot: state.settings,
      target: { id: "1:1", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=1", courseId: "1", courseName: "Fixture", category: "", week: "1", name: "UI fixture", assessmentKind: "practice", source: "manual" },
      mode: "from_current", status: "paused", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), page: 1,
      currentQuestion: 1, totalOnPage: 1, processedQuestionIds: [], startAnchorUsed: false, memorySourceQuizKey: null,
      memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: [], message: "Usage fixture",
      usage: { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsageRequests: 1, fallbackCount: 0,
        pending: [{ id: "ui-unknown-reservation", requestId: "ui-unknown-request", questionId: "q1", provider: "gemini_api", model: "fixture-gemini", status: "unknown", inputTokens: 120, outputTokens: 40 }],
        byModel: [{ provider: "gemini_api", model: "fixture-gemini", requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 }] }
    };
    await chrome.storage.session.set({ runSession: run });
  }, tabId);
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  await panel.getByText(/chưa xác định usage/, { exact: false }).waitFor({ timeout: 10000 });
  const resume = panel.getByRole("button", { name: /Tiếp tục/ });
  if (!(await resume.isDisabled())) throw new Error("Resume remained enabled with unresolved usage.");
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Giữ dự toán, khóa gửi lại" }).click();
  await panel.getByText(/Đã giữ dự toán bảo thủ/, { exact: false }).waitFor({ timeout: 10000 });
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.run.usage.pending[0]?.status === "estimated");
  if (await resume.isDisabled()) throw new Error("Resume did not unlock after explicit unknown usage reconciliation.");

  await worker.evaluate(async () => {
    const { runSession } = await chrome.storage.session.get("runSession");
    await chrome.storage.session.set({ runSession: { ...runSession, status: "answering", message: "UI stop fixture" } });
  });
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.run.status === "answering");
  const stop = panel.getByRole("button", { name: /Dừng/ });
  if (await stop.isDisabled()) throw new Error("Stop was disabled for a running session.");
  await stop.click();
  await panel.getByText("Đã dừng theo yêu cầu.").waitFor({ timeout: 10000 });
  if (!(await stop.isDisabled()) || await resume.isDisabled()) throw new Error("Stop/Resume controls did not reflect background state.");
  console.log("PASS: Web providers need no API key; Gemini API discovery, verification, expiry, model/provider persistence; legacy keys preserved; unknown budget and Stop/Resume UI.");
} finally {
  await context?.close();
  const relative = path.relative(tmpdir(), path.resolve(profile));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("tnu-ui-release-e2e-")) await rm(profile, { recursive: true, force: true });
}
