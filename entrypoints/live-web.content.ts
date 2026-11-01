import type { AIRequest, AIResponse, ProviderStatus } from "../src/web-adapter";
import { findCorrelatedLiveResponse, findLiveEditor, findLiveFileInput, findLiveSendButton, findLiveStopButton, findNewChatControl, isLiveGenerating, liveAssistantMessages, liveResponseText, liveUserMessageCount } from "../src/live-web-dom";
import { isBlankWebConversation, providerForWebUrl } from "../src/web-tabs";

interface LiveMessage { type: string; request?: AIRequest; requestId?: string; }
interface PreparedLiveRequest {
  request: AIRequest;
  baselineResponses: Set<HTMLElement>;
  baselineUserCount: number;
  submitted: boolean;
  cancelRequested: boolean;
  stopClicked: boolean;
}

const LIVE_BRIDGE_VERSION = "3.3.1";

const providerId = providerForWebUrl(location.href);
let conversationIdentity = `live-conversation-${crypto.randomUUID()}`;
let knownConversationUrl = conversationUrl();
let prepared: PreparedLiveRequest | undefined;
let latestResponseIdentity: string | undefined;

function conversationUrl(): string {
  return `${location.origin}${location.pathname}${location.search}`;
}

function syncConversationIdentity(): void {
  const current = conversationUrl();
  if (current !== knownConversationUrl && !prepared?.submitted) conversationIdentity = `live-conversation-${crypto.randomUUID()}`;
  knownConversationUrl = current;
}

function status(): ProviderStatus {
  if (!providerId) return { providerId: "gemini_web", state: "unsupported", message: "Website này không phải AI Web được hỗ trợ.", supportsImages: false, canAutomate: false };
  syncConversationIdentity();
  const editor = findLiveEditor(providerId);
  const loginVisible = Boolean(document.querySelector('input[type="email"], input[type="password"], a[href*="login" i], button[data-testid*="login" i]'));
  return {
    providerId,
    state: editor ? "ready" : loginVisible ? "login_required" : "unsupported",
    message: editor ? "Editor AI Web đã sẵn sàng." : loginVisible ? "Hãy đăng nhập provider trong tab đã chọn." : "Không tìm thấy editor; giao diện provider có thể đã thay đổi.",
    supportsImages: Boolean(findLiveFileInput(providerId)),
    canAutomate: Boolean(editor)
  };
}

function setEditorText(editor: HTMLElement, text: string): void {
  editor.focus();
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    editor.replaceChildren();
    for (const [index, line] of text.split("\n").entries()) {
      if (index) editor.append(document.createElement("br"));
      editor.append(document.createTextNode(line));
    }
  }
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function base64File(data: string, mimeType: string, index: number): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset);
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([bytes], `tnu-question-${index + 1}.${extension}`, { type: mimeType });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs: number, message: string): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function attachImages(request: AIRequest): Promise<void> {
  if (!request.question.images.length) return;
  if (!providerId) throw new Error("Provider AI Web không hợp lệ.");
  const input = findLiveFileInput(providerId);
  if (!input) throw new Error("Tab AI hiện tại không cung cấp input ảnh; request chưa được gửi.");
  const transfer = new DataTransfer();
  request.question.images.forEach((image, index) => transfer.items.add(base64File(image.data, image.mimeType, index)));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function prepareRequest(request: AIRequest): Promise<void> {
  if (!providerId || request.providerId !== providerId) throw new Error("Provider trong request không khớp tab AI.");
  const current = status();
  if (current.state !== "ready") throw new Error(current.message);
  if (request.conversationIdentity !== conversationIdentity) throw new Error("Cuộc trò chuyện đã thay đổi; hãy bind lại hoặc tạo chat mới.");
  const editor = findLiveEditor(providerId);
  if (!editor) throw new Error("Không tìm thấy editor AI Web.");
  await attachImages(request);
  setEditorText(editor, request.prompt);
  prepared = { request, baselineResponses: new Set(liveAssistantMessages(providerId)), baselineUserCount: liveUserMessageCount(providerId), submitted: false, cancelRequested: false, stopClicked: false };
}

async function submitRequest(requestId: string): Promise<{ dispatched: boolean }> {
  if (!providerId || !prepared || prepared.request.requestId !== requestId) throw Object.assign(new Error("Không có prompt khớp request để gửi."), { dispatched: false });
  const button = await waitFor(() => {
    const candidate = findLiveSendButton(providerId);
    return candidate && candidate.getAttribute("aria-disabled") !== "true" && !candidate.classList.contains("ds-button--disabled") && !(candidate instanceof HTMLButtonElement && candidate.disabled) ? candidate : undefined;
  }, 5000, "Không tìm thấy nút gửi đang khả dụng.").catch((error) => { throw Object.assign(error, { dispatched: false }); });
  prepared.submitted = true;
  button.click();
  try {
    await waitFor(() => liveUserMessageCount(providerId) > prepared!.baselineUserCount || isLiveGenerating(providerId) || liveAssistantMessages(providerId).some((item) => !prepared!.baselineResponses.has(item)) ? true : undefined, 4000, "Đã bấm gửi nhưng chưa xác nhận được provider đã nhận prompt.");
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { dispatched: true }); }
  return { dispatched: true };
}

function newAssistantResponse(state: PreparedLiveRequest): HTMLElement | undefined {
  const messages = liveAssistantMessages(providerId!);
  return [...messages].reverse().find((item) => !state.baselineResponses.has(item));
}

function responseIdentity(element: HTMLElement): string {
  const existing = element.dataset.tnuResponseIdentity || element.getAttribute("data-message-id") || element.id;
  if (existing) return existing;
  const identity = `live-response-${crypto.randomUUID()}`;
  element.dataset.tnuResponseIdentity = identity;
  return identity;
}

async function waitForResponse(requestId: string): Promise<AIResponse> {
  if (!providerId || !prepared || prepared.request.requestId !== requestId || !prepared.submitted) throw new Error("Request chưa được gửi từ tab AI này.");
  const state = prepared;
  const timeoutMs = Math.max(30_000, Math.min(state.request.timeoutMs ?? 300_000, 1_800_000));
  const started = Date.now();
  let lastText = "";
  let settledSamples = 0;
  while (Date.now() - started < timeoutMs) {
    if (state.cancelRequested) {
      if (!state.stopClicked) {
        const stop = findLiveStopButton(providerId);
        if (!stop) throw new Error("Không tìm thấy nút dừng; kết quả request vẫn chưa xác định.");
        state.stopClicked = true; stop.click();
      }
      if (!isLiveGenerating(providerId)) return { requestId, executionEpoch: state.request.executionEpoch, questionId: state.request.questionId, conversationIdentity: state.request.conversationIdentity, responseIdentity: "cancelled", role: "assistant", complete: false, cancelled: true, content: "" };
    }
    const response = newAssistantResponse(state);
    const correlated = findCorrelatedLiveResponse(providerId, requestId, state.request.questionId);
    const responseElement = response ?? correlated?.element;
    const responseText = response ? liveResponseText(response) : correlated?.content ?? "";
    // ChatGPT and DeepSeek can briefly pause while streaming. A generic "text is stable" check
    // can therefore return a truncated JSON object before the closing brace arrives.
    // Only expose ChatGPT content after a complete, correlated JSON object exists.
    const requiresCompleteJson = providerId === "chatgpt_web" || providerId === "deepseek_web";
    const text = requiresCompleteJson ? correlated?.content ?? "" : responseText;
    const generating = responseElement ? isLiveGenerating(providerId, responseElement) : true;
    if (responseElement && text && !generating) {
      settledSamples = text === lastText ? settledSamples + 1 : 0;
      lastText = text;
      if (settledSamples >= 2) {
        latestResponseIdentity = responseIdentity(responseElement);
        return { requestId, executionEpoch: state.request.executionEpoch, questionId: state.request.questionId, conversationIdentity: state.request.conversationIdentity, responseIdentity: latestResponseIdentity, role: "assistant", complete: true, content: text };
      }
    } else { lastText = text; settledSamples = 0; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Give a response that arrived exactly at the deadline a short, bounded settle window.
  const graceStarted = Date.now();
  while (Date.now() - graceStarted < 5_000) {
    const response = newAssistantResponse(state);
    const correlated = findCorrelatedLiveResponse(providerId, requestId, state.request.questionId);
    const responseElement = response ?? correlated?.element;
    const responseText = response ? liveResponseText(response) : correlated?.content ?? "";
    const requiresCompleteJson = providerId === "chatgpt_web" || providerId === "deepseek_web";
    const text = requiresCompleteJson ? correlated?.content ?? "" : responseText;
    if (responseElement && text && !isLiveGenerating(providerId, responseElement)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const latestCorrelated = findCorrelatedLiveResponse(providerId, requestId, state.request.questionId);
      const settledText = requiresCompleteJson
        ? latestCorrelated?.content ?? ""
        : response ? liveResponseText(response) : latestCorrelated?.content ?? "";
      if (settledText === text && !isLiveGenerating(providerId, responseElement)) {
        latestResponseIdentity = responseIdentity(responseElement);
        return { requestId, executionEpoch: state.request.executionEpoch, questionId: state.request.questionId, conversationIdentity: state.request.conversationIdentity, responseIdentity: latestResponseIdentity, role: "assistant", complete: true, content: settledText };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hết ${Math.round(timeoutMs / 1000)} giây chờ AI Web hoàn tất; không tự gửi lại request.`);
}

async function createConversation(): Promise<void> {
  if (!providerId) throw new Error("Provider AI Web không hợp lệ.");
  if (prepared?.submitted) throw new Error("Không thể tạo chat mới khi request cũ chưa được cleanup.");
  if (isBlankWebConversation(providerId, location.href) && findLiveEditor(providerId)) {
    knownConversationUrl = conversationUrl();
    conversationIdentity = `live-conversation-${crypto.randomUUID()}`;
    latestResponseIdentity = undefined;
    prepared = undefined;
    return;
  }
  const control = findNewChatControl(providerId);
  if (!control) throw new Error("Không tìm thấy nút tạo cuộc trò chuyện mới.");
  control.click();
  await waitFor(() => findLiveEditor(providerId) && (isBlankWebConversation(providerId, location.href)
    || (liveAssistantMessages(providerId).length === 0 && liveUserMessageCount(providerId) === 0)) ? true : undefined, 12_000, "Không xác minh được cuộc trò chuyện mới.");
  knownConversationUrl = conversationUrl();
  conversationIdentity = `live-conversation-${crypto.randomUUID()}`;
  latestResponseIdentity = undefined;
  prepared = undefined;
}

export default defineContentScript({
  matches: ["https://gemini.google.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://chat.deepseek.com/*"],
  runAt: "document_idle",
  main() {
    if (!providerId) return;
    browser.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
      const message = rawMessage as LiveMessage;
      if (!message.type.startsWith("WEB_LIVE_")) return false;
      const respond = (action: () => unknown | Promise<unknown>, dispatched = false) => {
        void Promise.resolve().then(action).then((value) => sendResponse({ ok: true, ...(typeof value === "object" && value ? value : {}) })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error), dispatched: (error as { dispatched?: boolean })?.dispatched ?? dispatched }));
        return true;
      };
      if (message.type === "WEB_LIVE_STATUS") {
        syncConversationIdentity();
        sendResponse({ ok: true, status: status(), conversationIdentity, latestResponseIdentity, bridgeVersion: LIVE_BRIDGE_VERSION }); return false;
      }
      if (message.type === "WEB_LIVE_PREPARE" && message.request) return respond(() => prepareRequest(message.request!));
      if (message.type === "WEB_LIVE_SUBMIT" && message.requestId) return respond(async () => ({ dispatched: (await submitRequest(message.requestId!)).dispatched }));
      if (message.type === "WEB_LIVE_WAIT" && message.requestId) return respond(async () => ({ response: await waitForResponse(message.requestId!) }), true);
      if (message.type === "WEB_LIVE_CANCEL" && message.requestId) {
        if (prepared?.request.requestId === message.requestId) prepared.cancelRequested = true;
        sendResponse({ ok: true }); return false;
      }
      if (message.type === "WEB_LIVE_NEW_CONVERSATION") return respond(createConversation);
      if (message.type === "WEB_LIVE_CLEANUP") { prepared = undefined; knownConversationUrl = conversationUrl(); sendResponse({ ok: true }); return false; }
      return false;
    });
  }
});

