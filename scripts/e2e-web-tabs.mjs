import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || "release/v3.4.1/chrome-mv3");
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = await mkdtemp(path.join(tmpdir(), "tnu-web-tabs-e2e-"));
let context;
let server;
const serverPort = await new Promise((resolve, reject) => {
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1`);
    if (!url.pathname.startsWith("/__tnu_fixture__/ai/")) {
      response.writeHead(404); response.end("not found"); return;
    }
    const mode = url.searchParams.get("mode") || "normal";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html data-fixture-images="true" data-fixture-mode="${mode}"><head><meta charset="utf-8"><title>Local Gemini Web Fixture</title></head><body><main><div id="chat-messages"></div><div id="fixture-images"></div><textarea id="chat-editor" aria-label="Chat editor"></textarea><button id="chat-submit" type="button">Send</button></main></body></html>`);
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const tnuUrl = "https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=1&cmid=123";
const quizHtml = `<form id="responseform">${[1, 2, 3].map((number) => `<div class="que" id="q${number}" style="min-height:600px"><div class="info"><h3>${number}</h3></div><div class="qtext">Câu ${number}: chọn kết quả của ${number} + 1.${number === 1 ? '<img alt="bảng phép tính" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=">' : ""}</div><div class="answer"><label><input type="radio" name="q${number}">Sai</label><label><input type="radio" name="q${number}">Đúng</label></div></div>`).join("")}<button name="submitall" type="submit">Nộp bài và kết thúc</button></form><script>window.__submitCount=0;document.querySelector('[name="submitall"]').addEventListener('click',event=>{event.preventDefault();window.__submitCount++})</script>`;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__apiCalls = [];
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("https://generativelanguage.googleapis.com/")) {
        globalThis.__apiCalls.push(url);
        if (url.includes(":generateContent")) return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.97, reason: "Gemini API fixture", needsHumanReview: false }) }] } }], usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 6, totalTokenCount: 21 } }), { status: 200 });
        if (url.includes("/models")) return new Response(JSON.stringify({ models: [{ name: "models/gemini-fixture", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
        throw new Error(`Unexpected Gemini request: ${url}`);
      }
      if (/api\.openai\.com|api\.anthropic\.com/.test(url)) throw new Error(`Unexpected legacy API request: ${url}`);
      return nativeFetch(input, init);
    };
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await context.route("https://tnu.aum.edu.vn/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: quizHtml }));
  const tnuPageWait = context.waitForEvent("page");
  const tnuWindow = await panel.evaluate(async (url) => chrome.windows.create({ url, focused: false, type: "normal" }), tnuUrl);
  const tnu = await tnuPageWait;
  await tnu.goto(tnuUrl);
  const aiPageWait = context.waitForEvent("page");
  const aiUrl = `http://127.0.0.1:${serverPort}/__tnu_fixture__/ai/gemini?mode=slow`;
  const aiWindow = await panel.evaluate(async (url) => chrome.windows.create({ url, focused: false, type: "normal" }), aiUrl);
  const ai = await aiPageWait;
  await ai.waitForURL(aiUrl);
  await ai.locator("#chat-editor").waitFor();
  if (tnuWindow.id === aiWindow.id) throw new Error("E2E fixture tabs were not opened in separate browser windows.");
  const tnuTabId = tnuWindow.tabs?.[0]?.id;
  const aiTabId = aiWindow.tabs?.[0]?.id;
  if (typeof tnuTabId !== "number" || typeof aiTabId !== "number") throw new Error("Could not obtain the fixture tab identities.");

  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  const providerSelect = panel.getByLabel("AI provider");
  await providerSelect.selectOption("gemini_web");
  await panel.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.provider === "gemini_web");
  const saveSettingsButton = panel.getByRole("button", { name: "Lưu cài đặt" });
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Lưu cài đặt");
    return button && !button.disabled;
  });
  const rotationControl = panel.getByLabel("Tạo chat Web mới sau số câu (0 = tắt)");
  await rotationControl.fill("2");
  await panel.waitForFunction(() => {
    const control = [...document.querySelectorAll("input")].find((item) => item.getAttribute("aria-label") === "Tạo chat Web mới sau số câu (0 = tắt)" || item.labels?.[0]?.textContent?.includes("Tạo chat Web mới sau số câu"));
    return control?.value === "2";
  });
  const rotationInput = await rotationControl.inputValue();
  await panel.getByLabel("Khoảng nghỉ giữa lần gửi AI (giây)").fill("0");
  await saveSettingsButton.click();
  await panel.getByText("Đã lưu cài đặt.").waitFor();
  const savedRotation = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.settings.manualRotationEvery);
  if (savedRotation !== 2) throw new Error(`Web rotation setting was not persisted; expected 2, got ${savedRotation}; input before save=${rotationInput}; raw=${JSON.stringify(await panel.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.manualRotationEvery))}.`);

  await panel.locator("nav").getByRole("button", { name: /Hàng đợi/ }).click();
  await panel.getByLabel("AI Web").selectOption("gemini_web");
  await panel.getByLabel("Tab TNU").selectOption(String(tnuTabId));
  await panel.getByLabel("Tab AI").selectOption(String(aiTabId));
  await panel.getByRole("button", { name: "Liên kết hai tab" }).click();
  await panel.getByRole("button", { name: "Kiểm tra liên kết" }).click();
  await panel.getByText("Editor AI Web và tab binding đã sẵn sàng.").waitFor({ timeout: 10000 });
  const binding = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data.webTabBinding);
  if (binding.tnuWindowId === binding.aiWindowId || binding.tnuTabId !== tnuTabId || binding.aiTabId !== aiTabId) throw new Error("Background did not persist the selected cross-window tab identities.");

  const target = { id: "fixture:123", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=123", courseId: "fixture-course", courseName: "Local fixture", category: "", week: "1", name: "Ba câu fixture", assessmentKind: "practice", source: "manual" };
  await panel.evaluate(async (quiz) => {
    const result = await chrome.runtime.sendMessage({ type: "SAVE_QUEUE", queue: [quiz] });
    if (!result.ok) throw new Error(result.error);
  }, target);
  await panel.getByRole("button", { name: "Từ câu hiện tại" }).click();
  await panel.getByRole("button", { name: "Xác nhận bắt đầu" }).click();
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  await ai.locator(".fixture-user").first().waitFor({ timeout: 15000 });
  if (await ai.locator("#fixture-images img").count() !== 1) {
    const debug = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    throw new Error(`The TNU image was not attached to the first fixture request; fixture images=${await ai.locator("#fixture-images img").count()}, current user=${await ai.locator(".fixture-user").first().innerText()}, run=${JSON.stringify(debug.data?.run)}`);
  }
  await ai.locator('.fixture-assistant[data-status="streaming"]').waitFor({ timeout: 10000 });
  if (await tnu.locator("#q1 input:checked").count()) throw new Error("TNU was filled before the streamed fixture response completed.");
  await tnu.waitForFunction(() => [...document.querySelectorAll(".que")].every((question) => question.querySelectorAll("input:checked").length === 1), null, { timeout: 45000 });
  await panel.waitForFunction(async () => {
    const run = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run;
    return run?.status === "paused" && run?.webCompletedCount === 3;
  }, null, { timeout: 15000 });
  const firstRun = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data.run;
  if (!firstRun.webFixture || firstRun.provider !== "gemini_web" || !firstRun.conversationIdentity) throw new Error("Fixture Web session identity was not persisted.");
  const rotationCount = await ai.locator("html").getAttribute("data-fixture-conversation-count");
  if (rotationCount !== "2") throw new Error(`Conversation was not rotated exactly once after two completed answers; fixture count=${rotationCount}; run count=${firstRun.webCompletedCount}; limit=${firstRun.settingsSnapshot.manualRotationEvery}; fixture users=${await ai.locator(".fixture-user").count()}.`);
  if (await ai.locator("#fixture-images img").count() !== 0) throw new Error("Chat rotation should leave only the third question in the new conversation.");
  if (await ai.locator(".fixture-user").count() !== 1) throw new Error("A stale conversation message survived rotation.");
  if (await tnu.evaluate(() => (window).__submitCount) !== 0) throw new Error("Extension submitted the TNU attempt.");
  if (await worker.evaluate(() => globalThis.__apiCalls.length) !== 0) throw new Error("AI Web fixture unexpectedly called a provider API.");
  console.log("PASS: two Chrome windows; one Start; streamed fixture replies; image request; three automatic TNU answers; one verified rotation; no manual message step; stop before submit; no real API call.");

  // Verify Stop, provider switch and Resume while a Web fixture response is streaming.
  await tnu.evaluate(() => {
    window.scrollTo(0, 0);
    for (const question of document.querySelectorAll(".que")) {
      question.querySelectorAll("input").forEach((input) => { input.checked = false; });
      question.removeAttribute("data-tnu-gemini-done");
      question.removeAttribute("data-tnu-gemini-error");
    }
  });
  await panel.locator("nav").getByRole("button", { name: /Hàng đợi/ }).click();
  await panel.getByRole("button", { name: "Từ câu hiện tại" }).click();
  await panel.getByRole("button", { name: "Xác nhận bắt đầu" }).click();
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  await ai.locator(".fixture-user").first().waitFor({ timeout: 10000 });
  await ai.locator('.fixture-assistant[data-status="streaming"]').waitFor({ timeout: 10000 });
  await panel.getByRole("button", { name: /Dừng/ }).click();
  await panel.waitForFunction(async () => {
    const run = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run;
    return run?.status === "paused" && !run?.webUnknownRequestId && !run?.activeExecution && run?.message?.includes("Fixture xác nhận generation đã dừng");
  }, null, { timeout: 15000 });
  if (await tnu.locator("#q1 input:checked").count()) throw new Error("A stopped Web answer was applied to TNU.");

  await panel.evaluate(async () => {
    const call = async (message) => { const result = await chrome.runtime.sendMessage(message); if (!result.ok) throw new Error(result.error); return result.data; };
    const { token } = await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "gemini_api" });
    await chrome.storage.local.set({ geminiApiKey: "fixture-only-key" });
    await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider: "gemini_api", token });
    await call({ type: "SELECT_GEMINI_MODEL", model: "gemini-fixture" });
  });
  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  await panel.getByLabel("AI provider").selectOption("gemini_api");
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  await panel.getByRole("button", { name: /Tiếp tục/ }).click();
  await tnu.waitForFunction(() => [...document.querySelectorAll(".que")].every((question) => question.querySelectorAll("input:checked").length === 1), null, { timeout: 30000 });
  const resumedRun = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data.run;
  if (resumedRun.provider !== "gemini_api" || resumedRun.webUnknownRequestId) throw new Error("Stop → Gemini API switch → Resume left a stale Web request active.");
  if (await tnu.evaluate(() => (window).__submitCount) !== 0) throw new Error("Resume submitted the TNU attempt.");
  if ((await worker.evaluate(() => globalThis.__apiCalls)).filter((url) => url.includes(":generateContent")).length !== 3) throw new Error("Gemini API mock did not receive exactly one request per remaining question.");
  console.log("PASS: Stop during Web streaming → confirmed cancellation → switch to Gemini API → Resume; stale Web response rejected and no duplicate Web send.");

  // MV3 can terminate the service worker during an in-flight Web request. Recovery must lock that request as UNKNOWN.
  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  await panel.getByLabel("AI provider").selectOption("gemini_web");
  await panel.locator("nav").getByRole("button", { name: /Hàng đợi/ }).click();
  await tnu.evaluate(() => {
    window.scrollTo(0, 0);
    for (const question of document.querySelectorAll(".que")) question.querySelectorAll("input").forEach((input) => { input.checked = false; });
  });
  await panel.getByRole("button", { name: "Từ câu hiện tại" }).click();
  await panel.getByRole("button", { name: "Xác nhận bắt đầu" }).click();
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  await ai.locator(".fixture-user").first().waitFor({ timeout: 10000 });
  await ai.locator('.fixture-assistant[data-status="streaming"]').waitFor({ timeout: 10000 });
  const cdp = await context.newCDPSession(panel);
  const workerVersions = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (event) => workerVersions.push(...event.versions));
  await cdp.send("ServiceWorker.enable");
  const waitFor = (predicate, description) => new Promise((resolve, reject) => {
    const interval = setInterval(() => { if (predicate()) { clearInterval(interval); clearTimeout(timeout); resolve(); } }, 50);
    const timeout = setTimeout(() => { clearInterval(interval); reject(new Error(description)); }, 8000);
  });
  await waitFor(() => workerVersions.some((item) => item.scriptURL.startsWith(`chrome-extension://${extensionId}/`)), "Could not observe the extension worker version.");
  const workerVersion = workerVersions.find((item) => item.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
  await cdp.send("ServiceWorker.stopWorker", { versionId: workerVersion.versionId });
  await waitFor(() => workerVersions.some((item) => item.versionId === workerVersion.versionId && item.runningStatus === "stopped"), "The extension worker did not stop.");
  await cdp.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extensionId}/` });
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const targets = await cdp.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find((item) => item.type === "service_worker" && item.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!workerTarget) throw new Error("Could not find the restarted extension service worker target.");
  const attached = await cdp.send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: false });
  let commandId = 0;
  const evaluateWorker = async (expression) => {
    const id = ++commandId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cdp.off("Target.receivedMessageFromTarget", receive); reject(new Error("No response from restarted worker.")); }, 8000);
      const receive = (event) => {
        if (event.sessionId !== attached.sessionId) return;
        const payload = JSON.parse(event.message);
        if (payload.id !== id) return;
        clearTimeout(timeout); cdp.off("Target.receivedMessageFromTarget", receive);
        if (payload.error || payload.result?.exceptionDetails) reject(new Error(JSON.stringify(payload.error || payload.result.exceptionDetails)));
        else resolve(payload.result?.result?.value);
      };
      cdp.on("Target.receivedMessageFromTarget", receive);
    });
    await cdp.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }) });
    return response;
  };
  await evaluateWorker(`(() => {
    globalThis.__apiCalls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error("Unexpected network call: " + url);
      globalThis.__apiCalls.push(url);
      if (url.includes(":generateContent")) return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.97, reason: "Gemini restart fixture", needsHumanReview: false }) }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-fixture", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
    };
    return true;
  })()`);
  await panel.waitForFunction(async () => {
    const run = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run;
    return run?.status === "paused" && Boolean(run?.webUnknownRequestId);
  }, null, { timeout: 15000 });
  const afterWorkerRestart = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data.run;
  if (await tnu.locator("#q1 input:checked").count()) throw new Error("The response from the terminated Web request was applied.");
  if (afterWorkerRestart.activeExecution?.status !== "unknown") throw new Error(`Worker restart did not mark in-flight Web delivery UNKNOWN; run=${JSON.stringify({ status: afterWorkerRestart.status, activeExecution: afterWorkerRestart.activeExecution, unknownId: afterWorkerRestart.webUnknownRequestId, provider: afterWorkerRestart.provider, executionEpoch: afterWorkerRestart.executionEpoch, error: afterWorkerRestart.error, message: afterWorkerRestart.message, completed: afterWorkerRestart.webCompletedCount })}.`);

  await panel.locator("nav").getByRole("button", { name: /Cài đặt/ }).click();
  await panel.getByLabel("AI provider").selectOption("gemini_api");
  await panel.locator("nav").getByRole("button", { name: /Đang chạy/ }).click();
  panel.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: /Tôi đã kiểm tra, không có phản hồi/ }).click();
  await panel.waitForFunction(async () => !(await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run?.webUnknownRequestId, null, { timeout: 10000 });
  await panel.getByRole("button", { name: /Tiếp tục/ }).click();
  await tnu.waitForFunction(() => [...document.querySelectorAll(".que")].every((question) => question.querySelectorAll("input:checked").length === 1), null, { timeout: 30000 });
  const postRestartCalls = await evaluateWorker("globalThis.__apiCalls.filter((url) => url.includes(':generateContent')).length");
  if (postRestartCalls !== 3) throw new Error(`Worker recovery/resume dispatched ${postRestartCalls} API requests instead of one per question.`);
  if (await ai.locator(".fixture-user").count() !== 1) throw new Error("Resume sent a duplicate Web request after worker restart.");
  if (await tnu.evaluate(() => window.__submitCount) !== 0) throw new Error("Worker restart recovery submitted the TNU attempt.");
  console.log("PASS: MV3 worker restart during Web stream → UNKNOWN, no stale fill or automatic resend; explicit reconciliation → Gemini API Resume.");
} finally {
  await context?.close();
  await new Promise((resolve) => server?.close(resolve));
  const relative = path.relative(tmpdir(), path.resolve(profile));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("tnu-web-tabs-e2e-")) await rm(profile, { recursive: true, force: true });
}
