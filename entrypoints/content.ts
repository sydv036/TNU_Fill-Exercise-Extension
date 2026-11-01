import { applyVerifiedDecisionToElement, isValidSelection, matchesQuestionSnapshot, detectPageKind, extractQuestion, extractReviewAnswerEntries, findQuestionElement, markSuggestion, parseCourseActivities, parseDashboardCourses } from "../src/moodle";
import { chunkText } from "../src/knowledge";
import { isAttemptForTarget, isReviewForTarget, nextReviewPageUrl } from "../src/quiz-navigation";
import { questionStartIndex, shouldPauseForDecision } from "../src/run-policy";
import pdfLibraryUrl from "pdfjs-dist/legacy/build/pdf.mjs?url&no-inline";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url&no-inline";
import type { AnswerDecision, AppState, CourseIndex, CourseMaterial, KnowledgeChunk, KnowledgeExtractionResult, QuestionImage, QuestionSnapshot, QuizTarget, RuntimeMessage, RuntimeResponse, RunSession } from "../src/types";

let processing = false;
let stopped = false;
let restartRequested = false;

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
    if (state.settings.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.settings.delayMs));
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
    const response = await runtime<AppState>({ type: "GET_STATE" });
    if (!response.ok || !response.data?.run) return;
    const state = response.data;
    const run = state.run!;
    activeRunId = run.id;
    activeEpoch = run.executionEpoch;
    const kind = detectPageKind(location.href, document);
    if (run.status === "paused") return;
    if (kind === "review") {
      if (!isReviewForTarget(location.href, run.target.url)) return;
      if (!document.querySelector(".que")) {
        await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "error", error: "Trang xem lại không hiển thị chi tiết câu hỏi.", message: "Không thể đọc đáp án đúng từ trang xem lại này." } });
        return;
      }
      const entries = extractReviewAnswerEntries(document, run.target, location.href);
      const nextReviewUrl = nextReviewPageUrl(document, location.href);
      const saved = await runtime<{ saved: number; total: number; nextTarget?: QuizTarget; batchCompleted?: boolean }>({
        type: "SAVE_REVIEW_ANSWERS", runId: run.id, executionEpoch: run.executionEpoch ?? "", entries, sourceUrl: location.href, reviewComplete: !nextReviewUrl
      });
      if (!saved.ok) throw new Error(saved.error || "Không lưu được đáp án từ trang xem lại.");
      if (saved.data?.saved) await runtime({ type: "NOTIFY", title: "Đã ghi nhớ đáp án", message: `Đã lưu ${saved.data.saved} đáp án đúng để đối chiếu ở lần làm sau.`, level: "success" });
      else if (!entries.length) await runtime({ type: "NOTIFY", title: "Không có cache mới", message: "Trang xem lại này không có đáp án đúng có thể lưu.", level: "warning" });
      if (nextReviewUrl) {
        if (run.practiceBatch || state.settings.autoNavigate) { if (await isSameEpoch(run)) location.assign(nextReviewUrl); }
        else await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "paused", message: "Đã lưu trang xem lại hiện tại. Hãy chuyển sang trang xem lại tiếp theo để lưu đủ cache." } });
        return;
      }
      if (saved.data?.nextTarget) {
        if (await isSameEpoch(run)) location.assign(saved.data.nextTarget.url);
        return;
      }
      if (saved.data?.batchCompleted) {
        await runtime({ type: "NOTIFY", title: "Hoàn tất chuỗi luyện tập", message: "Đã lưu các đáp án đúng đọc được của toàn bộ bài luyện tập đã chọn.", level: "success" });
      }
      return;
    }
    if (run.status === "awaiting_user" && run.pendingDecision) {
      const pendingElement = findQuestionElement(run.pendingDecision.question.id);
      if (pendingElement) markSuggestion(pendingElement, run.pendingDecision.decision.selectedOptionIds);
      return;
    }
    if (["paused", "completed"].includes(run.status)) return;
    if (kind === "summary") {
      const inBatch = Boolean(run.practiceBatch);
      await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: inBatch ? "awaiting_user" : "completed", message: inBatch ? "Đã điền xong bài luyện tập này. Hãy tự nộp; sau trang xem lại tool sẽ chuyển sang bài tiếp theo." : "Đã tới trang tổng kết. Hãy kiểm tra và tự nộp bài." } });
      await runtime({ type: "NOTIFY", title: "Đã xử lý xong", message: inBatch ? "Hãy tự nộp bài luyện tập để tool ghi nhớ đáp án đúng và chuyển bài tiếp theo." : "Extension đã dừng ở trang tổng kết và chưa nộp bài.", level: "success" });
      return;
    }
    if (kind === "quiz-view") {
      if (run.target.assessmentKind !== "practice") {
        await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { status: "awaiting_user", message: "Bài kiểm tra tính điểm: hãy tự xác nhận bắt đầu trên Moodle." } });
        return;
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
    void runtime({ type: "CONTENT_READY", url: location.href }).then(() => processRun());
  }
});
