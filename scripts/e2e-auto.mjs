import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || ".output/chrome-mv3");
const tempRoot = path.resolve(tmpdir());
const profile = await mkdtemp(path.join(tempRoot, "tnu-auto-e2e-"));
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__streams = [];
    globalThis.__immediate = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://generativelanguage.googleapis.com/") && url.includes(":generateContent")) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } }), { status: 429 });
      if (url.startsWith("https://generativelanguage.googleapis.com/") && url.includes("/models")) return new Response(JSON.stringify({ models: [{ name: "models/fixture-gemini", supportedGenerationMethods: ["generateContent"] }] }));
      if (url === "https://api.openai.com/v1/models") return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      if (url !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected network request: ${url}`);
      const body = JSON.parse(init.body);
      const prompt = body.input[0].content[0].text;
      const requestId = prompt.match(/Mã yêu cầu: ([\w-]+)/)?.[1];
      const questionId = prompt.match(/Câu hỏi ID: ([\w-]+)/)?.[1];
      if (!requestId || !questionId) throw new Error("Fixture missing correlation IDs");
      const answer = JSON.stringify({ requestId, questionId, selectedOptionIds: ["option_1"], confidence: 0.95, reason: "fixture", needsHumanReview: false });
      const payload = JSON.stringify({ status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer }] }] });
      if (globalThis.__immediate) return new Response(payload, { status: 200 });
      const bytes = new TextEncoder().encode(payload);
      const images = body.input[0].content.filter((part) => part.type === "input_image").length;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 30)); globalThis.__streams.push({ controller, tail: bytes.slice(30), questionId, images }); } }), { status: 200 });
    };
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const tnu = await context.newPage();
  const image = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
  const questions = [1, 2, 3].map((n) => `<div class="que" id="q${n}" style="min-height:500px"><div class="qtext">Câu ${n}: 2 + 2?${n === 1 ? `<img src="data:image/png;base64,${image}">` : ""}</div><div class="answer"><label><input type="radio" name="q${n}">3</label><label><input type="radio" name="q${n}">4</label></div></div>`).join("");
  await tnu.route("https://tnu.aum.edu.vn/**", (route) => {
    const summary = route.request().url().includes("summary.php");
    return route.fulfill({ status: 200, contentType: "text/html", body: summary ? '<h1>Trang tổng kết</h1><button name="submitall">Nộp bài</button>' : `<form id="responseform">${questions}<button name="next" type="button">Tiếp</button></form>` });
  });
  await tnu.goto("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=1&cmid=123");
  await tnu.evaluate(() => document.querySelector('button[name="next"]').addEventListener("click", () => {
    sessionStorage.setItem("fixtureAnswers", JSON.stringify([...document.querySelectorAll('.que')].map((q) => q.querySelectorAll('input')[1].checked)));
    location.assign("/mod/quiz/summary.php?attempt=1&cmid=123");
  }));
  await panel.evaluate(async () => {
    const call = async (msg) => { const result = await chrome.runtime.sendMessage(msg); if (!result.ok) throw new Error(result.error); return result.data; };
    const { token } = await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "openai_api" });
    await chrome.storage.local.set({ openaiApiKey: "fixture-only-key" });
    await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider: "openai_api", token });
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "fixture-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    const state = await call({ type: "GET_STATE" });
    await call({ type: "SAVE_SETTINGS", settings: { ...state.settings, delayMs: 0, notificationsEnabled: false } });
    const target = { id: "1:123", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=123", courseId: "1", courseName: "Fixture", category: "", week: "1", name: "Bài luyện tập giả lập", assessmentKind: "practice", source: "manual" };
    await call({ type: "SAVE_QUEUE", queue: [target] });
  });
  await panel.locator("nav").getByRole("button", { name: /Hàng đợi/ }).click();
  await panel.getByRole("button", { name: "Từ câu hiện tại" }).click();
  await panel.getByRole("button", { name: "Xác nhận bắt đầu" }).click();
  const waitForStream = async (index) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await worker.evaluate((n) => globalThis.__streams.length > n, index)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    throw new Error(`Không nhận được yêu cầu ${index + 1}: ${JSON.stringify(state.data?.run)}`);
  };
  for (let i = 0; i < 3; i++) {
    await waitForStream(i);
    const partial = await worker.evaluate((n) => globalThis.__streams[n].questionId, i);
    if (partial !== `q${i + 1}`) throw new Error(`Sai thứ tự câu: ${partial}`);
    if (i === 0 && await worker.evaluate(() => globalThis.__streams[0].images) !== 1) throw new Error("Không gửi ảnh câu hỏi trong fixture.");
    if (await tnu.locator(`#q${i + 1} input:checked`).count()) throw new Error("Đã điền trước khi phản hồi hoàn tất.");
    await worker.evaluate((n) => { const stream = globalThis.__streams[n]; stream.controller.enqueue(stream.tail); stream.controller.close(); }, i);
    if (i < 2) await tnu.waitForFunction((n) => document.querySelectorAll(`#q${n} input`)[1]?.checked === true, i + 1, { timeout: 15000 });
  }
  await tnu.waitForURL("**/mod/quiz/summary.php**", { timeout: 15000 });
  if (!(await tnu.evaluate(() => JSON.parse(sessionStorage.getItem("fixtureAnswers") || "[]").length === 3 && JSON.parse(sessionStorage.getItem("fixtureAnswers") || "[]").every(Boolean)))) throw new Error("Chưa điền đủ đáp án trước khi chuyển trang.");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run?.status === "completed", null, { timeout: 15000 });
  if (!(await tnu.locator('button[name="submitall"]').isVisible())) throw new Error("Không dừng tại bước trước khi nộp.");
  console.log("PASS: OpenAI API fixture: ba câu tự động, chờ đủ từng phản hồi chia đoạn, kiểm tra đáp án và dừng trước khi nộp. Không kết nối AI hay TNU thật.");

  // A second isolated run verifies a rejected Gemini request, verified fallback with image, and a strict request budget.
  await worker.evaluate(() => { globalThis.__immediate = true; });
  await tnu.goto("https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=1&cmid=123");
  await panel.evaluate(async () => {
    const call = async (msg) => { const result = await chrome.runtime.sendMessage(msg); if (!result.ok) throw new Error(result.error); return result.data; };
    await call({ type: "TEST_API_CAPABILITY", provider: "openai_api", image: false });
    await call({ type: "TEST_API_CAPABILITY", provider: "openai_api", image: true });
    const { token } = await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "gemini_api" });
    await chrome.storage.local.set({ geminiApiKey: "fixture-gemini-key" });
    await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider: "gemini_api", token });
    await call({ type: "SELECT_GEMINI_MODEL", model: "fixture-gemini" });
    await call({ type: "SWITCH_PROVIDER", provider: "gemini_api" });
    const state = await call({ type: "GET_STATE" });
    await call({ type: "SAVE_SETTINGS", settings: { ...state.settings, retryCount: 0, maxRequests: 2, fallbackEnabled: true, fallbackOrder: ["openai_api", "gemini_api", "anthropic_api"], fallbackMax: 1 } });
    await call({ type: "START_RUN", target: state.run.target, mode: "from_current", memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: [], tnuTabId: state.run.tnuTabId });
  });
  await tnu.waitForFunction(() => document.querySelectorAll('#q1 input')[1]?.checked === true, null, { timeout: 15000 });
  await panel.waitForFunction(async () => {
    const run = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run;
    return run?.status === "awaiting_user" && run?.error?.includes("giới hạn số yêu cầu");
  }, null, { timeout: 15000 });
  const budgetRun = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data.run;
  if (budgetRun.usage?.requests !== 2 || budgetRun.usage?.totalTokens !== 20 || !budgetRun.usage.byModel.some((item) => item.provider === "openai_api")) throw new Error("Sai thống kê fallback hoặc ngân sách.");
  if (await tnu.locator('#q2 input:checked').count()) throw new Error("Đã điền câu kế tiếp sau khi đạt ngân sách.");
  console.log("PASS: Gemini 429 → OpenAI fixture đã xác minh text/ảnh → chặn câu tiếp theo khi đạt giới hạn 2 yêu cầu.");
} finally {
  await context?.close();
  const relative = path.relative(tempRoot, path.resolve(profile));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("tnu-auto-e2e-")) await rm(profile, { recursive: true, force: true });
}
