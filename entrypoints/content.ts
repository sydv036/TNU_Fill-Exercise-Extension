import { applyVerifiedDecisionToElement, isValidSelection, matchesQuestionSnapshot, detectPageKind, extractQuestion, extractReviewAnswerEntries, findQuestionElement, markSuggestion, parseCourseActivities, parseDashboardCourses, parseReviewTarget } from "../src/moodle";
import { chunkText } from "../src/knowledge";
import { isAttemptForTarget, isReviewForTarget, nextReviewPageUrl } from "../src/quiz-navigation";
import { questionStartIndex, shouldPauseForDecision } from "../src/run-policy";
import { bestQuizScore, reviewScore, shouldStopForExistingFullScore } from "../src/practice-automation";
import pdfLibraryUrl from "pdfjs-dist/legacy/build/pdf.mjs?url&no-inline";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url&no-inline";
import type { AnswerDecision, AppState, CourseIndex, CourseMaterial, KnowledgeChunk, KnowledgeExtractionResult, QuestionImage, QuestionSnapshot, QuizTarget, RuntimeMessage, RuntimeResponse, RunSession } from "../src/types";

let processing = false;
let stopped = false;
let restartRequested = false;

async function runtime<T = unknown>(message: RuntimeMessage): Promise<RuntimeResponse<T>> {
  return browser.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
}

async function runtimeWithWorkerRetry<T = unknown>(message: RuntimeMessage, attempts = 4): Promise<RuntimeResponse<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runtime<T>(message);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Service worker không phản hồi."));
}

function injectStyles(): void {
  if (document.getElementById("tnu-gemini-styles")) return;
  const style = document.createElement("style");
  style.id = "tnu-gemini-styles";
  style.textContent = `
    [data-tnu-gemini-suggestion="true"] { outline: 3px solid #f59e0b !important; outline-offset: 3px; border-radius: 6px; background: #fffbeb !important; }
    [data-tnu-gemini-error="true"] { outline: 3px solid #ef4444 !important; outline-offset: 4px; }
    [data-tnu-gemini-done="true"] { box-shadow: inset 4px 0 #14b8a6; }
  `;
  document.documentElement.append(style);
}

async function blobToImage(blob: Blob): Promise<QuestionImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mimeType: blob.type || "image/png", data: btoa(binary) };
}

async function attachImages(element: HTMLElement, question: QuestionSnapshot): Promise<QuestionSnapshot> {
  const images: QuestionImage[] = [];
  const nodes = [...element.querySelectorAll<HTMLImageElement>(".qtext img, .answer img")];
  if (nodes.length > 3) throw new Error("Câu hỏi có hơn 3 ảnh; hãy xử lý thủ công để tránh bỏ sót ảnh.");
  for (const image of nodes) {
    try {
      const response = await fetch(image.currentSrc || image.src, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size || blob.size > 2_000_000 || !blob.type.startsWith("image/")) throw new Error("Ảnh trống, không hợp lệ hoặc lớn hơn 2 MB");
      images.push(await blobToImage(blob));
    } catch { throw new Error("Không thể đọc đầy đủ ảnh câu hỏi. Hãy xử lý thủ công rồi bỏ qua câu này."); }
  }
  return { ...question, images };
}

async function isCurrentRun(run: RunSession, requestId?: string): Promise<boolean> {
  const current = await runtime<AppState>({ type: "GET_STATE" });
  const latest = current.data?.run;
  return !stopped && Boolean(run.executionEpoch && latest?.id === run.id && latest.executionEpoch === run.executionEpoch && !["paused", "completed", "error"].includes(latest.status) && (!requestId || (latest.activeExecution?.requestId === requestId && latest.activeExecution.executionEpoch === run.executionEpoch && latest.activeExecution.status === "completed")));
}

async function isSameEpoch(run: RunSession): Promise<boolean> {
  const current = await runtime<AppState>({ type: "GET_STATE" });
  return !stopped && Boolean(run.executionEpoch && current.data?.run?.id === run.id && current.data.run.executionEpoch === run.executionEpoch && current.data.run.status !== "paused");
}

async function waitBetweenQuestions(run: RunSession): Promise<boolean> {
  const latest = await runtime<AppState>({ type: "GET_STATE" });
  const current = latest.data?.run;
  if (!latest.ok || !latest.data || !current || current.id !== run.id || current.executionEpoch !== run.executionEpoch || current.status !== "answering") return false;
  // This is an operational throttle: use the latest saved setting so changing
  // it while a session is active affects the next AI Web dispatch.
  const delayMs = Math.max(0, Math.min(60_000, latest.data.settings.delayMs));
  if (!delayMs) return true;
  await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { message: `Đang nghỉ ${(delayMs / 1000).toFixed(delayMs % 1000 ? 1 : 0)} giây trước câu tiếp theo...` } });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return isSameEpoch(run);
}

async function extractReviewEntriesWithRetry(document: Document, target: QuizTarget): Promise<ReturnType<typeof extractReviewAnswerEntries>> {
  let entries = extractReviewAnswerEntries(document, target, location.href);
  for (let attempt = 0; !entries.length && attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    entries = extractReviewAnswerEntries(document, target, location.href);
  }
  return entries;
}

async function applyVerified(element: HTMLElement, snapshot: QuestionSnapshot, ids: string[], run: RunSession, requestId?: string): Promise<boolean> {
  const current = await attachImages(element, extractQuestion(element, 0));
  if (current.images.length !== snapshot.images.length || current.images.some((image, index) => image.mimeType !== snapshot.images[index]?.mimeType || image.data !== snapshot.images[index]?.data)) return false;
  if (!await isCurrentRun(run, requestId)) return false;
  return applyVerifiedDecisionToElement(element, snapshot, ids);
}

async function matchesSnapshot(element: HTMLElement, snapshot: QuestionSnapshot): Promise<boolean> {
  const current = await attachImages(element, extractQuestion(element, 0));
  return current.images.length === snapshot.images.length && current.images.every((image, index) => image.mimeType === snapshot.images[index]?.mimeType && image.data === snapshot.images[index]?.data) && matchesQuestionSnapshot(element, snapshot);
}

async function scanCourses(): Promise<CourseIndex> {
  const stateResponse = await runtime<AppState>({ type: "GET_STATE" });
  if (!stateResponse.ok || !stateResponse.data) throw new Error(stateResponse.error || "Không đọc được cài đặt.");
  const dashboardUrl = "https://tnu.aum.edu.vn/my/";
  const dashboardDocument = location.pathname.startsWith("/my/")
    ? document
    : new DOMParser().parseFromString(await (await fetch(dashboardUrl, { credentials: "include" })).text(), "text/html");
  const baseCourses = parseDashboardCourses(dashboardDocument, dashboardUrl);
  const courses = [];
  for (const base of baseCourses) {
    const html = await (await fetch(base.url, { credentials: "include" })).text();
    const courseDocument = new DOMParser().parseFromString(html, "text/html");
    courses.push({ ...base, weeks: parseCourseActivities(courseDocument, base, stateResponse.data.settings) });
  }
  return { courses, scannedAt: new Date().toISOString(), sourceUrl: location.href };
}

function actualResourceUrl(document: Document, baseUrl: string): string | undefined {
  const node = document.querySelector<HTMLElement>('object[data], embed[src], iframe[src], a[href*="/pluginfile.php/"], a[href$=".pdf"]');
  const raw = node?.getAttribute("data") || node?.getAttribute("src") || node?.getAttribute("href");
  if (!raw) return undefined;
  try { return new URL(raw, baseUrl).href; } catch { return undefined; }
}

async function pdfChunks(material: CourseMaterial, bytes: ArrayBuffer): Promise<KnowledgeChunk[]> {
  const extensionUrl = (path: string) => (browser.runtime.getURL as (value: string) => string)(path.replace(/^\//, ""));
  const { getDocument, GlobalWorkerOptions } = await import(/* @vite-ignore */ extensionUrl(pdfLibraryUrl)) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = (browser.runtime.getURL as (path: string) => string)(pdfWorkerUrl.replace(/^\//, ""));
  const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const chunks: KnowledgeChunk[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => "str" in item ? item.str : "").join(" ");
    chunkText(text).forEach((part, index) => chunks.push({
      id: `${material.id}:p${pageNumber}:${index}`, courseId: material.courseId, materialId: material.id,
      materialName: material.name, materialUrl: material.url, week: material.week, kind: material.kind,
      page: pageNumber, text: part
    }));
  }
  await pdf.destroy();
  return chunks;
}

async function extractMaterial(material: CourseMaterial): Promise<KnowledgeChunk[]> {
  let response = await fetch(material.url, { credentials: "include", redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    const html = await response.text();
    const resourceDocument = new DOMParser().parseFromString(html, "text/html");
    const fileUrl = actualResourceUrl(resourceDocument, response.url || material.url);
    if (fileUrl) {
      response = await fetch(fileUrl, { credentials: "include", redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    } else {
      const text = (resourceDocument.querySelector("#region-main, main, .resourcecontent")?.textContent ?? "").replace(/\s+/g, " ").trim();
      return chunkText(text).map((part, index) => ({
        id: `${material.id}:html:${index}`, courseId: material.courseId, materialId: material.id,
        materialName: material.name, materialUrl: material.url, week: material.week, kind: material.kind, text: part
      }));
    }
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 50_000_000) throw new Error("Tệp lớn hơn giới hạn 50 MB");
  if (contentType.includes("pdf") || response.url.toLowerCase().includes(".pdf")) return pdfChunks(material, bytes);
  throw new Error(`Chưa hỗ trợ định dạng ${contentType || "không xác định"}`);
}

async function extractCourseMaterials(materials: CourseMaterial[]): Promise<KnowledgeExtractionResult> {
  const chunksByMaterial: KnowledgeChunk[][] = Array.from({ length: materials.length }, () => []);
  const failedMaterials: KnowledgeExtractionResult["failedMaterials"] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < materials.length) {
      const index = cursor++;
      const material = materials[index]!;
      try {
        chunksByMaterial[index] = await extractMaterial(material);
      } catch (error) {
        failedMaterials.push({ materialId: material.id, name: material.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, materials.length) }, worker));
  const chunks = chunksByMaterial.flat();
  return { chunks: chunks.slice(0, 1200), failedMaterials };
}

function currentQuestionStart(elements: HTMLElement[]): number {
  if (!elements.length) return 0;
  const viewportTarget = Math.max(0, window.innerHeight * 0.18);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  elements.forEach((element, index) => {
    const distance = Math.abs(element.getBoundingClientRect().top - viewportTarget);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  });
  return bestIndex;
}

function nextButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>('input[name="next"], button[name="next"], .mod_quiz-next-nav');
}

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function finalSubmitControl(): HTMLElement | null {
  const legacy = [...document.querySelectorAll<HTMLElement>('button[name="submitall"], input[name="submitall"]')].find(visible);
  if (legacy) return legacy;
  // TNU's Moodle theme omits name="submitall". Identify the finish form by
  // both its destination and finishattempt marker, then require the exact
  // user-facing submit label so another processattempt button cannot match.
  const forms = [...document.querySelectorAll<HTMLFormElement>('form#frm-finishattempt, form[action*="/mod/quiz/processattempt.php"]')];
  for (const form of forms) {
    if (!form.querySelector('input[name="finishattempt"]')) continue;
    const controls = [...form.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]')].filter(visible);
    const exact = controls.find((control) => /^(nộp bài và kết thúc|submit all and finish)$/i.test((control.textContent || (control as HTMLInputElement).value || "").replace(/\s+/g, " ").trim()));
    if (exact) return exact;
  }
  return null;
}

function submitConfirmationControl(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('.modal.show, .modal[aria-hidden="false"], [role="dialog"]')].filter(visible);
  for (const dialog of dialogs) {
    const text = (dialog.textContent ?? "").replace(/\s+/g, " ");
    if (!/(nộp bài|submit all|finish attempt)/i.test(text)) continue;
    const controls = [...dialog.querySelectorAll<HTMLElement>('button[data-action="save"], button.btn-primary, input.btn-primary[type="submit"]')].filter(visible);
    const exact = controls.find((control) => /(nộp bài và kết thúc|submit all and finish|xác nhận|confirm)/i.test((control.textContent || (control as HTMLInputElement).value || "").trim()));
    if (exact) return exact;
  }
  return null;
}

async function submitPractice(run: RunSession): Promise<void> {
  if (run.target.assessmentKind !== "practice" || !run.practiceAutomation?.enabled) throw new Error("Tự nộp chỉ được phép với bài luyện tập ở chế độ Full điểm.");
  if (!run.executionEpoch || !await isSameEpoch(run)) return;
  const control = finalSubmitControl();
  if (!control) throw new Error("Không tìm thấy đúng nút nộp bài luyện tập; extension đã dừng an toàn.");
  const updated = await runtime({
    type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch,
    patch: { status: "navigating", practiceAutomation: { ...run.practiceAutomation, submitPhase: "submitting" }, message: `Đang nộp lần làm ${run.practiceAutomation.attemptNumber}/${run.practiceAutomation.maxAttempts}...` }
  });
  if (!updated.ok || !await isSameEpoch(run)) return;
  control.click();
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!location.pathname.includes("/mod/quiz/summary.php")) return;
    const confirm = submitConfirmationControl();
    if (confirm) {
      confirm.click();
      await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { practiceAutomation: { ...run.practiceAutomation, submitPhase: "submitted" }, message: "Đã xác nhận nộp bài; đang chờ trang xem lại..." } });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (location.pathname.includes("/mod/quiz/summary.php")) {
    await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", practiceAutomation: { ...run.practiceAutomation, submitPhase: "ready" }, message: "Không xác minh được hộp thoại nộp bài. Hãy nộp thủ công để tiếp tục." } });
  }
}

async function pauseAtQuestion(run: RunSession, question: QuestionSnapshot, message: string, decision?: AnswerDecision): Promise<void> {
  if (!await isCurrentRun(run)) return;
  findQuestionElement(question.id)?.setAttribute("data-tnu-gemini-error", "true");
  const recoverableDecision: AnswerDecision = decision ?? {
    selectedOptionIds: [], confidence: 0, reason: message, needsHumanReview: true
  };
  const updated = await runtime({
    type: "UPDATE_RUN",
    runId: run.id,
    executionEpoch: run.executionEpoch,
    patch: { status: "awaiting_user", message, error: decision ? undefined : message, pendingDecision: { question, decision: recoverableDecision }, webCompletedResponse: undefined }
  });
  if (!updated.ok) return;
  await runtime({ type: "NOTIFY", title: "TNU Gemini cần bạn", message, level: "warning" });
}

async function processAttempt(run: RunSession, state: AppState): Promise<void> {
  const elements = [...document.querySelectorAll<HTMLElement>("#responseform .que, form#responseform .que")];
  if (!elements.length) throw new Error("Không tìm thấy câu hỏi trên trang hiện tại.");
  const page = Number(new URL(location.href).searchParams.get("page") ?? "0") + 1;
  const startIndex = questionStartIndex(run, page, run.mode === "from_current" && !run.startAnchorUsed ? currentQuestionStart(elements) : 0);
  await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "answering", page, totalOnPage: elements.length, startAnchorUsed: true, startAnchorPage: run.startAnchorUsed ? run.startAnchorPage : page, startAnchorIndex: run.startAnchorUsed ? run.startAnchorIndex : startIndex, message: `Đang xử lý trang ${page}...` } });
  let processed = [...run.processedQuestionIds];
  for (let index = startIndex; index < elements.length; index++) {
    if (stopped) return;
    const element = elements[index]!;
    let question = extractQuestion(element, index);
    if (processed.includes(question.id)) continue;
    markSuggestion(element, []);
    element.removeAttribute("data-tnu-gemini-error");
    await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { currentQuestion: index + 1, currentQuestionSnapshot: { ...question, images: [] }, message: `Đang đối chiếu bộ nhớ đáp án cho ${question.number}...` } });
    if (question.type === "unsupported" || !question.options.length) {
      await pauseAtQuestion(run, question, `${question.number} có loại chưa được hỗ trợ. Hãy tự xử lý rồi chọn Bỏ qua.`);
      return;
    }
    try { question = await attachImages(element, question); }
    catch (error) { await pauseAtQuestion(run, question, error instanceof Error ? error.message : String(error)); return; }
    const answer = await runtime<AnswerDecision>({ type: "ANSWER_QUESTION", runId: run.id, executionEpoch: run.executionEpoch ?? "", question });
    const latest = await runtime<AppState>({ type: "GET_STATE" });
    if (stopped || latest.data?.run?.id !== run.id || latest.data.run.executionEpoch !== run.executionEpoch || latest.data.run.status === "paused") return;
    if (!answer.ok || !answer.data) {
      await pauseAtQuestion(run, question, answer.error || `Không xử lý được ${question.number}.`);
      return;
    }
    const decision = answer.data;
    const decisionSettings = run.settingsSnapshot ?? state.settings;
    const needsConfirmation = Boolean(run.dryRunLimit || decision.manualRequestId)
      || shouldPauseForDecision(run, decision, decisionSettings.confidenceThreshold, decisionSettings.uncertainMode);
    if (needsConfirmation) {
      markSuggestion(element, decision.selectedOptionIds);
      const source = decision.source === "memory" ? "Bộ nhớ đáp án đúng" : decision.source === "manual" ? "AI Web" : `${decision.source === "openai" ? "OpenAI" : decision.source === "anthropic" ? "Claude" : "Gemini"}${decision.reasoningPass ? " sau khi suy luận lại" : ""}`;
      await pauseAtQuestion(run, question, decision.manualRequestId ? `${question.number}: chờ bạn gửi câu hỏi tới ${source} và dán phản hồi.` : `${question.number}: ${source} đề xuất ${decision.selectedOptionIds.join(", ")} (${Math.round(decision.confidence * 100)}%).`, decision);
      return;
    }
    if (!await applyVerified(element, question, decision.selectedOptionIds, run, decision.executionRequestId)) {
      if (!await isCurrentRun(run, decision.executionRequestId)) return;
      await pauseAtQuestion(run, question, `Không thể chọn đáp án cho ${question.number}.`);
      return;
    }
    element.setAttribute("data-tnu-gemini-done", "true");
    processed = [...processed, question.id];
    await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { processedQuestionIds: processed, webCompletedResponse: undefined, message: `Đã xử lý ${question.number}.` } });
    if (!await waitBetweenQuestions(run)) return;
  }
  if (stopped) return;
  if (run.dryRunLimit) {
    await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "completed", message: "Đã chạy thử hết các câu trên trang hiện tại; không điền đáp án hoặc chuyển trang." } });
    return;
  }
  const next = nextButton();
  if (next && state.settings.autoNavigate) {
    const navigation = await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "navigating", message: "Đang chuyển sang trang tiếp theo..." } });
    if (!navigation.ok || !await isCurrentRun(run)) return;
    next.click();
    return;
  }
  await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: next ? "Đã xong trang. Tự chuyển trang đang tắt." : "Không tìm thấy nút chuyển trang; hãy kiểm tra thủ công." } });
}

async function processRun(): Promise<void> {
  if (processing) { restartRequested = true; return; }
  processing = true;
  stopped = false;
  let activeRunId: string | undefined;
  let activeEpoch: string | undefined;
  try {
    const response = await runtimeWithWorkerRetry<AppState>({ type: "GET_STATE" });
    if (!response.ok || !response.data) return;
    const state = response.data;
    const kind = detectPageKind(location.href, document);
    if (kind === "review") {
      const run = state.run;
      const target = run && isReviewForTarget(location.href, run.target.url) ? run.target : parseReviewTarget(document, location.href);
      if (!target) return;
      activeRunId = run?.id;
      activeEpoch = run?.executionEpoch;
      if (!document.querySelector(".que")) {
        if (run) await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "error", error: "Trang xem lại không hiển thị chi tiết câu hỏi.", message: "Không thể đọc đáp án đúng từ trang xem lại này." } });
        return;
      }
      const entries = await extractReviewEntriesWithRetry(document, target);
      const nextReviewUrl = nextReviewPageUrl(document, location.href);
      const score = reviewScore(document);
      const saved = await runtimeWithWorkerRetry<{ saved: number; total: number; nextTarget?: QuizTarget; batchCompleted?: boolean; retryingPractice?: boolean; navigationEpoch?: string }>({
        type: "SAVE_REVIEW_ANSWERS", runId: run?.id, executionEpoch: run?.executionEpoch, target, entries, sourceUrl: location.href, reviewComplete: !nextReviewUrl, score
      });
      if (!saved.ok) throw new Error(saved.error || "Không lưu được đáp án từ trang xem lại.");
      if (saved.data?.saved) await runtime({ type: "NOTIFY", title: "Đã ghi nhớ đáp án", message: `Đã lưu ${saved.data.saved} đáp án đúng để đối chiếu ở lần làm sau.`, level: "success" });
      else if (!entries.length) await runtime({ type: "NOTIFY", title: "Không có cache mới", message: "Trang xem lại này không có đáp án đúng có thể lưu.", level: "warning" });
      if (nextReviewUrl) {
        if (run?.practiceBatch || (run && state.settings.autoNavigate)) { if (await isSameEpoch(run)) location.assign(nextReviewUrl); }
        else if (run) await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: "Đã lưu trang xem lại hiện tại. Hãy chuyển sang trang xem lại tiếp theo để lưu đủ cache." } });
        return;
      }
      if (saved.data?.nextTarget) {
        if (saved.data.navigationEpoch) {
          const latest = await runtime<AppState>({ type: "GET_STATE" });
          if (latest.data?.run?.executionEpoch === saved.data.navigationEpoch && latest.data.run.target.id === saved.data.nextTarget.id && latest.data.run.status === "preparing") location.assign(saved.data.nextTarget.url);
        } else if (run && await isSameEpoch(run)) location.assign(saved.data.nextTarget.url);
        return;
      }
      if (saved.data?.batchCompleted) {
        await runtime({ type: "NOTIFY", title: "Hoàn tất chuỗi luyện tập", message: "Đã lưu các đáp án đúng đọc được của toàn bộ bài luyện tập đã chọn.", level: "success" });
      }
      return;
    }
    if (!state.run) return;
    const run = state.run;
    activeRunId = run.id;
    activeEpoch = run.executionEpoch;
    if (run.status === "awaiting_user" && run.pendingDecision) {
      const pendingElement = findQuestionElement(run.pendingDecision.question.id);
      if (pendingElement) markSuggestion(pendingElement, run.pendingDecision.decision.selectedOptionIds);
      return;
    }
    if (["paused", "completed"].includes(run.status)) return;
    if (kind === "summary") {
      const inBatch = Boolean(run.practiceBatch);
      // V3.5.1 did not attach automation state to batch runs. Recover an
      // already-open summary from the persisted setting after upgrading, so
      // the user does not need to restart the whole practice sequence.
      if (!run.practiceAutomation && run.target.assessmentKind === "practice" && state.settings.practiceFullScoreEnabled && !run.dryRunLimit) {
        const practiceAutomation = {
          enabled: true as const,
          autoSubmit: state.settings.practiceAutoSubmit,
          collectCacheWhenFull: state.settings.practiceCollectCacheWhenFull,
          maxAttempts: state.settings.practiceMaxAttempts,
          attemptNumber: 1,
          webRetryCount: state.settings.webAutoRetryCount,
          scoreHistory: [],
          submitPhase: "idle" as const
        };
        const recovered = await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "answering", settingsSnapshot: { ...run.settingsSnapshot, ...state.settings }, practiceAutomation, message: "Đã khôi phục chế độ tự động đạt điểm tối đa cho chuỗi luyện tập." } });
        if (recovered.ok) restartRequested = true;
        return;
      }
      if (run.practiceAutomation?.enabled && run.target.assessmentKind === "practice") {
        if (run.practiceAutomation.autoSubmit) {
          if (["submitting", "submitted"].includes(run.practiceAutomation.submitPhase)) {
            await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: "Lần nộp trước chưa xác định kết quả sau khi trang tải lại. Hãy kiểm tra Moodle trước khi tiếp tục." } });
            return;
          }
          await submitPractice(run); return;
        }
        await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "awaiting_user", practiceAutomation: { ...run.practiceAutomation, submitPhase: "ready" }, message: "Đã điền xong. Bấm “Nộp và tiếp tục” để kiểm tra điểm." } });
        await runtime({ type: "NOTIFY", title: "Sẵn sàng nộp bài", message: "Extension đang chờ bạn bấm Nộp và tiếp tục.", level: "success" });
        return;
      }
      await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: inBatch ? "awaiting_user" : "completed", message: inBatch ? "Đã điền xong bài luyện tập này. Hãy tự nộp; sau trang xem lại tool sẽ chuyển sang bài tiếp theo." : "Đã tới trang tổng kết. Hãy kiểm tra và tự nộp bài." } });
      await runtime({ type: "NOTIFY", title: "Đã xử lý xong", message: inBatch ? "Hãy tự nộp bài luyện tập để tool ghi nhớ đáp án đúng và chuyển bài tiếp theo." : "Extension đã dừng ở trang tổng kết và chưa nộp bài.", level: "success" });
      return;
    }
    if (kind === "quiz-view") {
      if (run.target.assessmentKind !== "practice") {
        await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "awaiting_user", message: "Bài kiểm tra tính điểm: hãy tự xác nhận bắt đầu trên Moodle." } });
        return;
      }
      if (run.practiceAutomation?.enabled) {
        const best = bestQuizScore(document);
        if (best && shouldStopForExistingFullScore(run.practiceAutomation, best)) {
          await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "completed", practiceAutomation: { ...run.practiceAutomation, scoreHistory: [...run.practiceAutomation.scoreHistory, best], submitPhase: "reviewing" }, message: `Bài này đã đạt điểm tối đa ${best.label}; không cần làm lại.` } });
          await runtime({ type: "NOTIFY", title: "Đã đủ điểm", message: `Điểm cao nhất hiện tại là ${best.label}.`, level: "success" });
          return;
        }
      }
      const confirm = document.querySelector<HTMLElement>("#id_submitbutton");
      const start = document.querySelector<HTMLElement>('button[name="startattempt"], input[name="startattempt"], form[action*="/mod/quiz/startattempt.php"] button[type="submit"], form[action*="/mod/quiz/startattempt.php"] input[type="submit"]');
      const target = confirm ?? start;
      if (!target) throw new Error("Không tìm thấy nút bắt đầu/làm lại bài luyện tập.");
      const preparing = await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "preparing", message: "Đang bắt đầu bài luyện tập..." } });
      if (!preparing.ok || !await isCurrentRun(run)) return;
      target.click();
      return;
    }
    if (kind !== "attempt") {
      await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: "Trang hiện tại không phải trang làm quiz." } });
      return;
    }
    if (!isAttemptForTarget(location.href, run.target.url)) {
      await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: "Tab TNU đang mở bài khác với phiên đã chọn. Hãy mở lại đúng bài." } });
      return;
    }
    await processAttempt(run, run.settingsSnapshot ? { ...state, settings: run.settingsSnapshot } : state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A tab message can reject when the MV3 worker is stopped. If recovery has
    // already fenced this execution, its late rejection must not replace the
    // durable paused/UNKNOWN state with a generic error.
    let updated: RuntimeResponse | undefined;
    if (activeRunId && activeEpoch) {
      const latest = await runtime<AppState>({ type: "GET_STATE" }).catch(() => undefined);
      const currentRun = latest?.data?.run;
      if (currentRun?.id === activeRunId && currentRun.executionEpoch === activeEpoch && !["paused", "completed", "error"].includes(currentRun.status)) {
        updated = await runtime({ type: "UPDATE_RUN", runId: activeRunId, executionEpoch: activeEpoch, patch: { status: "error", error: message, message } }).catch(() => undefined);
      }
    }
    if (updated?.ok) await runtime({ type: "NOTIFY", title: "TNU Gemini gặp lỗi", message, level: "error" });
  } finally {
    processing = false;
    if (restartRequested) { restartRequested = false; void processRun(); }
  }
}

async function applyPending(executionEpoch?: string): Promise<void> {
  const response = await runtime<AppState>({ type: "GET_STATE" });
  const run = response.data?.run;
  const pending = run?.pendingDecision;
  if (!run || !pending || !executionEpoch || run.executionEpoch !== executionEpoch || run.status !== "awaiting_user" || stopped) throw new Error("Phiên đã dừng hoặc thay đổi; không áp dụng kết quả cũ.");
  if (!isAttemptForTarget(location.href, run.target.url)) throw new Error("Tab không còn ở đúng bài của phiên; không áp dụng đáp án.");
  const element = findQuestionElement(pending.question.id);
  const valid = element && (run.dryRunLimit ? isValidSelection(pending.question, pending.decision.selectedOptionIds) && await matchesSnapshot(element, pending.question) && await isCurrentRun(run, pending.decision.executionRequestId) : await applyVerified(element, pending.question, pending.decision.selectedOptionIds, run, pending.decision.executionRequestId));
  if (!element || !valid) throw new Error("Câu hỏi, ảnh hoặc phương án đã thay đổi; không thể áp dụng gợi ý.");
  element.removeAttribute("data-tnu-gemini-error");
  element.setAttribute("data-tnu-gemini-done", "true");
  const dryRunCount = (run.dryRunCount ?? 0) + 1;
  const dryRunDone = Boolean(run.dryRunLimit && dryRunCount >= run.dryRunLimit);
  await runtime({
    type: "UPDATE_RUN",
    runId: run.id,
    executionEpoch: run.executionEpoch,
    patch: {
      status: dryRunDone ? "completed" : "answering", error: undefined, pendingDecision: undefined,
      dryRunCount: run.dryRunLimit ? dryRunCount : undefined,
      processedQuestionIds: [...new Set([...run.processedQuestionIds, pending.question.id])],
      message: dryRunDone ? `Đã chạy thử ${dryRunCount} câu, không điền đáp án.` : run.dryRunLimit ? `Đã ghi nhận ${pending.question.number}, không điền đáp án.` : `Đã áp dụng gợi ý cho ${pending.question.number}.`
    }
  });
  if (dryRunDone) return;
  await processRun();
}

async function skipPending(executionEpoch?: string): Promise<void> {
  const response = await runtime<AppState>({ type: "GET_STATE" });
  const run = response.data?.run;
  const pendingId = run?.pendingDecision?.question.id;
  if (!run || !executionEpoch || run.executionEpoch !== executionEpoch || run.status !== "awaiting_user" || stopped) throw new Error("Phiên đã dừng hoặc thay đổi; không bỏ qua câu cũ.");
  await runtime({
    type: "UPDATE_RUN",
    runId: run.id,
    executionEpoch: run.executionEpoch,
    patch: {
      executionEpoch: crypto.randomUUID(), activeExecution: undefined, status: "answering", error: undefined, pendingDecision: undefined,
      processedQuestionIds: pendingId ? [...new Set([...run.processedQuestionIds, pendingId])] : run.processedQuestionIds,
      message: "Đã bỏ qua câu hiện tại."
    }
  });
  await processRun();
}

export default defineContentScript({
  matches: ["https://tnu.aum.edu.vn/*"],
  runAt: "document_idle",
  main() {
    injectStyles();
    browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
      if (message.type === "SCAN_COURSES") {
        scanCourses().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      if (message.type === "EXTRACT_COURSE_MATERIALS") {
        extractCourseMaterials(message.materials).then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      if (message.type === "STOP_RUN") { stopped = true; restartRequested = false; sendResponse({ ok: true }); return false; }
      if (message.type === "APPLY_SUGGESTION") { applyPending(message.executionEpoch).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) })); return true; }
      if (message.type === "SUBMIT_PRACTICE") {
        void runtime<AppState>({ type: "GET_STATE" }).then((state) => {
          const run = state.data?.run;
          if (!run || !message.executionEpoch || run.executionEpoch !== message.executionEpoch || run.status !== "awaiting_user" || run.practiceAutomation?.submitPhase !== "ready") throw new Error("Bài luyện tập không ở trạng thái sẵn sàng nộp.");
          return submitPractice(run);
        }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
      }
      if (message.type === "SHOW_VERIFICATION") {
        void runtime<AppState>({ type: "GET_STATE" }).then((result) => {
          if (!stopped && message.executionEpoch && result.data?.run?.executionEpoch === message.executionEpoch && result.data.run.status === "awaiting_user" && result.data.run.pendingDecision?.question.id === message.questionId) {
            const element = findQuestionElement(message.questionId);
            if (element) markSuggestion(element, message.selectedOptionIds);
          }
          sendResponse({ ok: true });
        });
        return true;
      }
      if (message.type === "SKIP_QUESTION") { skipPending(message.executionEpoch).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) })); return true; }
      if (["RESUME_RUN", "RETRY_QUESTION"].includes(message.type)) { void processRun(); sendResponse({ ok: true }); return false; }
      return false;
    });
    // A Manifest V3 worker may be asleep while the content script starts. The
    // review capture must still run even if this best-effort ready signal is
    // rejected, otherwise a fully graded review can silently remain uncached.
    void runtimeWithWorkerRetry({ type: "CONTENT_READY", url: location.href })
      .catch(() => undefined)
      .finally(() => processRun());
    window.addEventListener("pageshow", () => {
      if (detectPageKind(location.href, document) === "review") void processRun();
    });
  }
});
