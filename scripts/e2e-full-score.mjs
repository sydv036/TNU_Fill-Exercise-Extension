import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || ".output/chrome-mv3");
const profile = await mkdtemp(path.join(path.resolve(tmpdir()), "tnu-full-score-e2e-"));
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__fullScoreApiCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/models") return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      if (url !== "https://api.openai.com/v1/responses") throw new Error(`Unexpected network request: ${url}`);
      globalThis.__fullScoreApiCalls++;
      const body = JSON.parse(init.body);
      const prompt = body.input[0].content[0].text;
      const requestId = prompt.match(/Mã yêu cầu: ([\w:-]+)/)?.[1];
      const questionId = prompt.match(/Câu hỏi ID: ([\w:-]+)/)?.[1];
      const answer = JSON.stringify({ requestId, questionId, selectedOptionIds: ["option_0"], confidence: 0.95, reason: "fixture deliberately wrong once", needsHumanReview: false });
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer }] }] }));
    };
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const tnu = await context.newPage();
  let attemptCount = 0;
  let reviewCount = 0;
  let submitCount = 0;
  await tnu.route("https://tnu.aum.edu.vn/**", async (route) => {
    const url = new URL(route.request().url());
    let body = "";
    if (url.pathname.endsWith("/view.php")) {
      body = `<main id="region-main"><h1>Bài luyện tập fixture</h1><button name="startattempt" onclick="location.assign('/mod/quiz/attempt.php?attempt=${attemptCount + 1}&cmid=123')">Làm lại bài</button></main>`;
    } else if (url.pathname.endsWith("/attempt.php")) {
      attemptCount++;
      body = `<form id="responseform"><div class="que" id="q1"><div class="qtext">2 + 2 bằng bao nhiêu?</div><div class="answer"><label><input type="radio" name="q1">3</label><label><input type="radio" name="q1">4</label></div></div><button name="next" type="button" onclick="location.assign('/mod/quiz/summary.php?attempt=${attemptCount}&cmid=123')">Tiếp</button></form>`;
    } else if (url.pathname.endsWith("/summary.php")) {
      body = `<main><h1>Trang tổng kết</h1><form method="post" action="/mod/quiz/processattempt.php" id="frm-finishattempt" onsubmit="document.getElementById('confirm-dialog').className='modal show'; return false"><input type="hidden" name="attempt"><input type="hidden" name="finishattempt"><input type="hidden" name="timeup"><input type="hidden" name="slots"><input type="hidden" name="cmid"><input type="hidden" name="sesskey"><button type="submit" class="btn btn-primary" id="single_button_fixture">Nộp bài và kết thúc</button></form><div id="confirm-dialog" class="modal" role="dialog"><p>Nộp bài và kết thúc?</p><button class="btn-primary" data-action="save" onclick="location.assign('/mod/quiz/review.php?attempt=${attemptCount}&cmid=123')">Nộp bài và kết thúc</button></div></main>`;
      submitCount++;
    } else if (url.pathname.endsWith("/review.php")) {
      reviewCount++;
      const full = reviewCount >= 2;
      body = `<main id="region-main"><table><tr><td>Điểm</td><td>${full ? "10,00" : "0,00"} out of 10,00</td></tr></table><div class="que ${full ? "correct" : "incorrect"}" id="q1"><div class="info"><h3>Câu 1</h3><div class="state">${full ? "Đúng" : "Sai"}</div></div><div class="qtext">2 + 2 bằng bao nhiêu?</div><div class="answer"><div><label><input type="radio" name="q1" ${full ? "" : "checked"}>3</label></div><div class="correct"><label><input type="radio" name="q1" ${full ? "checked" : ""}>4</label></div></div><div class="rightanswer">Đáp án đúng là: 4</div></div><nav class="breadcrumb"><a href="/course/view.php?id=1">Môn fixture</a><a href="/course/view.php?id=1#section-1">Tuần 1</a><a href="/mod/quiz/view.php?id=123">Bài luyện tập fixture</a></nav></main>`;
    }
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  await tnu.goto("https://tnu.aum.edu.vn/mod/quiz/view.php?id=123");
  await panel.evaluate(async () => {
    const call = async (message) => { const result = await chrome.runtime.sendMessage(message); if (!result.ok) throw new Error(result.error); return result.data; };
    const lease = await call({ type: "BEGIN_CREDENTIAL_CHANGE", provider: "openai_api" });
    await chrome.storage.local.set({ openaiApiKey: "fixture-key" });
    await call({ type: "COMPLETE_CREDENTIAL_CHANGE", provider: "openai_api", token: lease.token });
    await call({ type: "SELECT_PROVIDER_MODEL", provider: "openai_api", model: "fixture-model" });
    await call({ type: "SWITCH_PROVIDER", provider: "openai_api" });
    const state = await call({ type: "GET_STATE" });
    await call({ type: "SAVE_SETTINGS", settings: { ...state.settings, delayMs: 0, notificationsEnabled: false, practiceFullScoreEnabled: true, practiceAutoSubmit: true, practiceMaxAttempts: 3, webAutoRetryCount: 1 } });
    const target = { id: "1:123", url: "https://tnu.aum.edu.vn/mod/quiz/view.php?id=123", courseId: "1", courseName: "Fixture", category: "", week: "1", name: "Bài luyện tập fixture", assessmentKind: "practice", source: "manual" };
    const [tnu] = await chrome.tabs.query({ url: "https://tnu.aum.edu.vn/*" });
    await call({ type: "START_RUN", target, mode: "from_start", memorySourceQuizKeys: [], reviewEveryAnswer: false, knowledgeMaterialIds: [], tnuTabId: tnu.id });
  });
  let state;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    state = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).data;
    if (state?.run?.status === "completed" && state.run.practiceAutomation?.scoreHistory?.at(-1)?.full) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state?.run?.practiceAutomation?.scoreHistory?.at(-1)?.full) throw new Error(`Full-score workflow timed out: url=${tnu.url()}, dialog=${await tnu.locator('#confirm-dialog').getAttribute('class').catch(() => 'missing')}, run=${JSON.stringify(state?.run)}`);
  const apiCalls = await worker.evaluate(() => globalThis.__fullScoreApiCalls);
  if (attemptCount !== 2 || reviewCount !== 2 || submitCount !== 2) throw new Error(`Sai vòng lặp: attempts=${attemptCount}, reviews=${reviewCount}, submits=${submitCount}, url=${tnu.url()}, run=${JSON.stringify(state.run)}`);
  if (apiCalls !== 1) throw new Error(`Cache không được dùng ở lần hai; API calls=${apiCalls}`);
  if (state.run.practiceAutomation?.scoreHistory?.length !== 2 || !state.run.practiceAutomation.scoreHistory[1]?.full || state.answerMemoryCount !== 1) throw new Error(`Sai trạng thái full-score/cache: ${JSON.stringify(state.run.practiceAutomation)}`);
  console.log("PASS: practice full-score loop submitted twice, learned the correct review answer, reused cache, and stopped at 10/10.");
} finally {
  await context?.close();
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(profile));
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(profile).startsWith("tnu-full-score-e2e-")) await rm(profile, { recursive: true, force: true });
}
