import { applyDecisionToElement, detectPageKind, extractQuestion, extractReviewAnswerEntries, findQuestionElement, markSuggestion, parseCourseActivities, parseDashboardCourses } from "../src/moodle";
import { chunkText } from "../src/knowledge";
import { isReviewForTarget, nextReviewPageUrl } from "../src/quiz-navigation";
import { shouldPauseForDecision } from "../src/run-policy";
import pdfLibraryUrl from "pdfjs-dist/legacy/build/pdf.mjs?url&no-inline";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url&no-inline";
import type { AnswerDecision, AppState, CourseIndex, CourseMaterial, KnowledgeChunk, KnowledgeExtractionResult, QuestionImage, QuestionSnapshot, QuizTarget, RuntimeMessage, RuntimeResponse, RunSession } from "../src/types";

let processing = false;
let stopped = false;

async function runtime<T = unknown>(message: RuntimeMessage): Promise<RuntimeResponse<T>> {
  return browser.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
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
  for (const image of [...element.querySelectorAll<HTMLImageElement>(".qtext img, .answer img")].slice(0, 3)) {
    try {
      const response = await fetch(image.currentSrc || image.src, { credentials: "include" });
      const blob = await response.blob();
      if (blob.size > 0 && blob.size <= 2_000_000) images.push(await blobToImage(blob));
    } catch { /* Ảnh lỗi không làm hỏng câu chữ. */ }
  }
  return { ...question, images };
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

async function pauseAtQuestion(run: RunSession, question: QuestionSnapshot, message: string, decision?: AnswerDecision): Promise<void> {
  findQuestionElement(question.id)?.setAttribute("data-tnu-gemini-error", "true");
  const recoverableDecision: AnswerDecision = decision ?? {
    selectedOptionIds: [], confidence: 0, reason: message, needsHumanReview: true
  };
  await runtime({
    type: "UPDATE_RUN",
    patch: { status: "awaiting_user", message, error: decision ? undefined : message, pendingDecision: { question, decision: recoverableDecision } }
  });
  await runtime({ type: "NOTIFY", title: "TNU Gemini cần bạn", message, level: "warning" });
}

async function processAttempt(run: RunSession, state: AppState): Promise<void> {
  const elements = [...document.querySelectorAll<HTMLElement>("#responseform .que, form#responseform .que")];
  if (!elements.length) throw new Error("Không tìm thấy câu hỏi trên trang hiện tại.");
  const page = Number(new URL(location.href).searchParams.get("page") ?? "0") + 1;
  let startIndex = 0;
  if (run.mode === "from_current" && !run.startAnchorUsed) startIndex = currentQuestionStart(elements);
  await runtime({ type: "UPDATE_RUN", patch: { status: "answering", page, totalOnPage: elements.length, startAnchorUsed: true, message: `Đang xử lý trang ${page}...` } });
  let processed = [...run.processedQuestionIds];
  for (let index = startIndex; index < elements.length; index++) {
    if (stopped) return;
    const element = elements[index]!;
    let question = extractQuestion(element, index);
    if (processed.includes(question.id)) continue;
    await runtime({ type: "UPDATE_RUN", patch: { currentQuestion: index + 1, currentQuestionSnapshot: { ...question, images: [] }, message: `Đang đối chiếu bộ nhớ đáp án cho ${question.number}...` } });
    if (question.type === "unsupported" || !question.options.length) {
      await pauseAtQuestion(run, question, `${question.number} có loại chưa được hỗ trợ. Hãy tự xử lý rồi chọn Bỏ qua.`);
      return;
    }
    question = await attachImages(element, question);
    const answer = await runtime<AnswerDecision>({ type: "ANSWER_QUESTION", question });
    if (!answer.ok || !answer.data) {
      await pauseAtQuestion(run, question, answer.error || `Không xử lý được ${question.number}.`);
      return;
    }
    const decision = answer.data;
    const needsConfirmation = shouldPauseForDecision(run, decision, state.settings.confidenceThreshold);
    if (needsConfirmation) {
      markSuggestion(element, decision.selectedOptionIds);
      const source = decision.source === "memory" ? "Bộ nhớ đáp án đúng" : decision.reasoningPass ? "Gemini sau khi suy luận lại" : "Gemini";
      await pauseAtQuestion(run, question, `${question.number}: ${source} đề xuất ${decision.selectedOptionIds.join(", ")} (${Math.round(decision.confidence * 100)}%).`, decision);
      return;
    }
    if (!applyDecisionToElement(element, decision.selectedOptionIds)) {
      await pauseAtQuestion(run, question, `Không thể chọn đáp án cho ${question.number}.`);
      return;
    }
    element.setAttribute("data-tnu-gemini-done", "true");
    processed = [...processed, question.id];
    await runtime({ type: "UPDATE_RUN", patch: { processedQuestionIds: processed, message: `Đã xử lý ${question.number}.` } });
    if (state.settings.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.settings.delayMs));
  }
  if (stopped) return;
  const next = nextButton();
  if (next && state.settings.autoNavigate) {
    await runtime({ type: "UPDATE_RUN", patch: { status: "navigating", message: "Đang chuyển sang trang tiếp theo..." } });
    next.click();
    return;
  }
  await runtime({ type: "UPDATE_RUN", patch: { status: "paused", message: next ? "Đã xong trang. Tự chuyển trang đang tắt." : "Không tìm thấy nút chuyển trang; hãy kiểm tra thủ công." } });
}

async function processRun(): Promise<void> {
  if (processing) return;
  processing = true;
  stopped = false;
  try {
    const response = await runtime<AppState>({ type: "GET_STATE" });
    if (!response.ok || !response.data?.run) return;
    const state = response.data;
    const run = state.run!;
    const kind = detectPageKind(location.href, document);
    if (kind === "review") {
      if (!isReviewForTarget(location.href, run.target.url)) return;
      const entries = extractReviewAnswerEntries(document, run.target, location.href);
      const nextReviewUrl = nextReviewPageUrl(document, location.href);
      const saved = await runtime<{ saved: number; total: number; nextTarget?: QuizTarget; batchCompleted?: boolean }>({
        type: "SAVE_REVIEW_ANSWERS", entries, sourceUrl: location.href, reviewComplete: !nextReviewUrl
      });
      if (!saved.ok) throw new Error(saved.error || "Không lưu được đáp án từ trang xem lại.");
      if (saved.data?.saved) await runtime({ type: "NOTIFY", title: "Đã ghi nhớ đáp án", message: `Đã lưu ${saved.data.saved} đáp án đúng để đối chiếu ở lần làm sau.`, level: "success" });
      if (nextReviewUrl) {
        if (run.practiceBatch || state.settings.autoNavigate) location.assign(nextReviewUrl);
        else await runtime({ type: "UPDATE_RUN", patch: { status: "paused", message: "Đã lưu trang xem lại hiện tại. Hãy chuyển sang trang xem lại tiếp theo để lưu đủ cache." } });
        return;
      }
      if (saved.data?.nextTarget) {
        location.assign(saved.data.nextTarget.url);
        return;
      }
      if (saved.data?.batchCompleted) {
        await runtime({ type: "NOTIFY", title: "Hoàn tất chuỗi luyện tập", message: "Đã lưu đáp án đúng của toàn bộ bài luyện tập đã chọn.", level: "success" });
      }
      return;
    }
    if (["paused", "completed"].includes(run.status)) return;
    if (kind === "summary") {
      const inBatch = Boolean(run.practiceBatch);
      await runtime({ type: "UPDATE_RUN", patch: { status: inBatch ? "awaiting_user" : "completed", message: inBatch ? "Đã điền xong bài luyện tập này. Hãy tự nộp; sau trang xem lại tool sẽ chuyển sang bài tiếp theo." : "Đã tới trang tổng kết. Hãy kiểm tra và tự nộp bài." } });
      await runtime({ type: "NOTIFY", title: "Đã xử lý xong", message: inBatch ? "Hãy tự nộp bài luyện tập để tool ghi nhớ đáp án đúng và chuyển bài tiếp theo." : "Extension đã dừng ở trang tổng kết và chưa nộp bài.", level: "success" });
      return;
    }
    if (kind === "quiz-view") {
      if (run.target.assessmentKind !== "practice") {
        await runtime({ type: "UPDATE_RUN", patch: { status: "awaiting_user", message: "Bài kiểm tra tính điểm: hãy tự xác nhận bắt đầu trên Moodle." } });
        return;
      }
      const confirm = document.querySelector<HTMLElement>("#id_submitbutton");
      const start = document.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]');
      const target = confirm ?? start;
      if (!target) throw new Error("Không tìm thấy nút bắt đầu/làm lại bài luyện tập.");
      await runtime({ type: "UPDATE_RUN", patch: { status: "preparing", message: "Đang bắt đầu bài luyện tập..." } });
      target.click();
      return;
    }
    if (kind !== "attempt") {
      await runtime({ type: "UPDATE_RUN", patch: { status: "paused", message: "Trang hiện tại không phải trang làm quiz." } });
      return;
    }
    await processAttempt(run, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await runtime({ type: "UPDATE_RUN", patch: { status: "error", error: message, message } });
    await runtime({ type: "NOTIFY", title: "TNU Gemini gặp lỗi", message, level: "error" });
  } finally {
    processing = false;
  }
}

async function applyPending(): Promise<void> {
  const response = await runtime<AppState>({ type: "GET_STATE" });
  const run = response.data?.run;
  const pending = run?.pendingDecision;
  if (!run || !pending) return;
  const element = findQuestionElement(pending.question.id);
  if (!element || !applyDecisionToElement(element, pending.decision.selectedOptionIds)) throw new Error("Không thể áp dụng gợi ý vào câu hiện tại.");
  element.removeAttribute("data-tnu-gemini-error");
  element.setAttribute("data-tnu-gemini-done", "true");
  await runtime({
    type: "UPDATE_RUN",
    patch: {
      status: "answering", error: undefined, pendingDecision: undefined,
      processedQuestionIds: [...new Set([...run.processedQuestionIds, pending.question.id])],
      message: `Đã áp dụng gợi ý cho ${pending.question.number}.`
    }
  });
  await processRun();
}

async function skipPending(): Promise<void> {
  const response = await runtime<AppState>({ type: "GET_STATE" });
  const run = response.data?.run;
  const pendingId = run?.pendingDecision?.question.id;
  if (!run) return;
  await runtime({
    type: "UPDATE_RUN",
    patch: {
      status: "answering", error: undefined, pendingDecision: undefined,
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
      if (message.type === "STOP_RUN") { stopped = true; sendResponse({ ok: true }); return false; }
      if (message.type === "APPLY_SUGGESTION") { applyPending().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) })); return true; }
      if (message.type === "SHOW_VERIFICATION") {
        const element = findQuestionElement(message.questionId);
        if (element) markSuggestion(element, message.selectedOptionIds);
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "SKIP_QUESTION") { skipPending().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) })); return true; }
      if (["RESUME_RUN", "RETRY_QUESTION"].includes(message.type)) { void processRun(); sendResponse({ ok: true }); return false; }
      return false;
    });
    void runtime({ type: "CONTENT_READY", url: location.href }).then(() => processRun());
  }
});
