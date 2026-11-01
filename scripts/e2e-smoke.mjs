import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || "release/v3.3.1/chrome-mv3");
const profile = await mkdtemp(path.join(tmpdir(), "tnu-v3-smoke-"));
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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
    globalThis.__tnuSmokeCalls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected request in API fixture: ${url}`);
      globalThis.__tnuSmokeCalls.push(url);
      if (url.includes(":generateContent")) return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ selectedOptionIds: ["option_1"], confidence: 0.97, reason: "Local API smoke fixture", needsHumanReview: false }) }] } }] }), { status: 200 });
      if (url.includes("/models")) return new Response(JSON.stringify({ models: [{ name: "models/tnu-smoke", displayName: "TNU Smoke", supportedGenerationMethods: ["generateContent"] }] }), { status: 200 });
      throw new Error(`Unexpected Gemini API fixture endpoint: ${url}`);
    };
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const tnu = await context.newPage();
  await tnu.route("https://tnu.aum.edu.vn/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: '<form id="responseform"><div class="que" id="q1"><div class="info"><h3>1</h3></div><div class="qtext">Smoke fixture: chọn đáp án đầu tiên.</div><div class="answer"><label><input type="radio" name="q1">Đáp án A</label><label><input type="radio" name="q1">Đáp án B</label></div></div><button name="submitall" type="submit">Nộp bài</button><script>window.__submitCount=0;document.querySelector("[name=submitall]").addEventListener("click",e=>{e.preventDefault();window.__submitCount++})</script></form>'
  }));
  const tnuUrl = "https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=1&cmid=123";
  await tnu.goto(tnuUrl);

  const target = { id: "smoke:123", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=123", courseId: "smoke-course", courseName: "Local smoke", category: "", week: "1", name: "Local API smoke", assessmentKind: "practice", source: "manual" };
  const start = await panel.evaluate(async (quiz) => {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const [tab] = await chrome.tabs.query({ url: "https://tnu.aum.edu.vn/*" });
    if (!tab?.id) throw new Error("Could not locate the local TNU fixture tab.");
    await chrome.storage.local.set({ geminiApiKey: "fixture-only-key" });
    const selectedModel = await chrome.runtime.sendMessage({ type: "SELECT_GEMINI_MODEL", model: "tnu-smoke" });
    if (!selectedModel.ok) throw new Error(selectedModel.error);
    const switched = await chrome.runtime.sendMessage({ type: "SWITCH_PROVIDER", provider: "gemini_api" });
    if (!switched.ok) throw new Error(switched.error);
    const queued = await chrome.runtime.sendMessage({ type: "SAVE_QUEUE", queue: [quiz] });
    if (!queued.ok) throw new Error(queued.error);
    return chrome.runtime.sendMessage({ type: "START_RUN", target: quiz, mode: "from_current", memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: [], tnuTabId: tab.id });
  }, target);
  if (!start.ok) throw new Error(start.error);

  await tnu.waitForFunction(() => document.querySelector('#q1 input[type="radio"]:checked') !== null, null, { timeout: 20000 });
  await panel.waitForFunction(async () => {
    const run = (await chrome.runtime.sendMessage({ type: "GET_STATE" })).data?.run;
    return run?.status === "paused" && run.processedQuestionIds.includes("q1");
  }, null, { timeout: 10000 });
  const result = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data;
  if (result.run.provider !== "gemini_api" || result.run.settingsSnapshot.model !== "tnu-smoke") throw new Error("The current run did not retain its selected Gemini API/model.");
  if (await worker.evaluate(() => globalThis.__tnuSmokeCalls.filter((url) => url.includes(":generateContent")).length) !== 1) throw new Error("The fixture did not receive exactly one API answer request.");
  if (await tnu.evaluate(() => window.__submitCount) !== 0) throw new Error("The extension submitted the TNU attempt.");

  const previousEpoch = result.run.executionEpoch;
  const stop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_RUN" }));
  if (!stop.ok) throw new Error(stop.error);
  const stale = await panel.evaluate(async ({ run, executionEpoch }) => chrome.runtime.sendMessage({
    type: "ANSWER_QUESTION", runId: run.id, executionEpoch,
    question: { id: "stale-question", number: "Stale", type: "single_choice", prompt: "Stale response", options: [{ id: "option_1", label: "A" }], images: [] }
  }), { run: result.run, executionEpoch: previousEpoch });
  if (stale.ok) throw new Error("A request from a completed session was accepted as current.");
  console.log("PASS: V3 Gemini API fixture → local TNU answer fill, current provider/model retained, one request only, stale run rejected, no quiz submission.");
} finally {
  await context?.close();
  const relative = path.relative(tmpdir(), path.resolve(profile));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("tnu-v3-smoke-")) await rm(profile, { recursive: true, force: true });
}
