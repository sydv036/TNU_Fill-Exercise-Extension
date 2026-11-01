import type { AIRequest, AIResponse, ProviderStatus } from "../src/web-adapter";
import { providerForWebUrl } from "../src/web-tabs";

interface FixtureMessage {
  type: string;
  request?: AIRequest;
  requestId?: string;
}

const providerId = providerForWebUrl(location.href);
const fixtureRoot = document.documentElement;
let conversationIdentity = `fixture-conversation-${crypto.randomUUID()}`;
let prepared: AIRequest | undefined;
let latestResponseIdentity: string | undefined;
let conversationGenerationCount = 0;
fixtureRoot.dataset.fixtureConversationIdentity = conversationIdentity;
fixtureRoot.dataset.fixtureConversationCount = "0";
const responses = new Map<string, AIResponse>();
const waiters = new Map<string, Array<(response: AIResponse) => void>>();
const generations = new Map<string, AbortController>();

function fixtureStatus(): ProviderStatus {
  const loginRequired = fixtureRoot.dataset.fixtureState === "login_required";
  return {
    providerId: providerId ?? "gemini_web",
    state: loginRequired ? "login_required" : providerId ? "ready" : "unsupported",
    message: loginRequired ? "Fixture requires sign-in." : "Local fixture adapter is ready.",
    supportsImages: fixtureRoot.dataset.fixtureImages !== "false",
    canAutomate: Boolean(providerId)
  };
}

function appendMessage(role: "user" | "assistant", text: string, responseId: string, status: string): HTMLElement {
  const message = document.createElement("article");
  message.className = `fixture-message fixture-${role}`;
  message.dataset.role = role;
  message.dataset.responseId = responseId;
  message.dataset.status = status;
  message.textContent = text;
  document.querySelector("#chat-messages")?.append(message);
  return message;
}

async function prepareRequest(request: AIRequest): Promise<{ ok: boolean; error?: string }> {
  const status = fixtureStatus();
  if (status.state !== "ready") return { ok: false, error: status.message };
  if (request.providerId !== providerId) return { ok: false, error: "Fixture provider mismatch." };
  if (request.question.images.length && !status.supportsImages) return { ok: false, error: "Image input is disabled in this fixture." };
  prepared = request;
  const editor = document.querySelector<HTMLTextAreaElement>("#chat-editor");
  if (!editor) return { ok: false, error: "Fixture editor is missing." };
  editor.value = request.prompt;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  const imageList = document.querySelector<HTMLElement>("#fixture-images");
  if (imageList) {
    imageList.replaceChildren(...request.question.images.map((image, index) => {
      const preview = document.createElement("img");
      preview.alt = `question image ${index + 1}`;
      preview.dataset.mimeType = image.mimeType;
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      return preview;
    }));
  }
  return { ok: true };
}

async function submitRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  if (!prepared || prepared.requestId !== requestId) return { ok: false, error: "No matching prepared fixture request." };
  const request = prepared;
  const status = fixtureRoot.dataset.fixtureMode;
  if (status === "before_send_error") return { ok: false, error: "Fixture rejected before dispatch." };
  const editor = document.querySelector<HTMLTextAreaElement>("#chat-editor");
  if (!editor || editor.value !== request.prompt) return { ok: false, error: "Fixture editor changed before submit." };
  appendMessage("user", editor.value, requestId, "complete");
  editor.value = "";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  const optionId = request.question.options.find((option) => option.id === "option_1")?.id ?? request.question.options[0]?.id;
  const responseText = status === "invalid_response" ? "not json" : JSON.stringify({
    requestId,
    questionId: request.questionId,
    selectedOptionIds: optionId ? [optionId] : [],
    confidence: 0.96,
    reason: "Local fixture response.",
    needsHumanReview: false
  });
  const responseIdentity = `fixture-response-${crypto.randomUUID()}`;
  latestResponseIdentity = responseIdentity;
  const assistant = appendMessage("assistant", "", responseIdentity, "streaming");
  const fullResponse: AIResponse = {
    requestId: status === "stale_response" ? "stale-request" : request.requestId,
    executionEpoch: request.executionEpoch,
    questionId: request.questionId,
    conversationIdentity: status === "conversation_changed" ? `changed-${conversationIdentity}` : conversationIdentity,
    responseIdentity,
    role: status === "user_intervention" ? "user" : "assistant",
    complete: true,
    content: responseText
  };
  const delay = status === "slow" ? 250 : 8;
  const generation = new AbortController();
  generations.set(requestId, generation);
  void (async () => {
    let accumulated = "";
    for (let index = 0; index < responseText.length; index += 12) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (generation.signal.aborted) { generations.delete(requestId); return; }
      accumulated += responseText.slice(index, index + 12);
      assistant.textContent = accumulated;
    }
    if (generation.signal.aborted) { generations.delete(requestId); return; }
    assistant.dataset.status = "complete";
    responses.set(requestId, fullResponse);
    generations.delete(requestId);
    for (const resolve of waiters.get(requestId) ?? []) resolve(fullResponse);
    waiters.delete(requestId);
  })();
  return { ok: true };
}

export default defineContentScript({
  matches: ["http://127.0.0.1/*", "http://localhost/*"],
  runAt: "document_idle",
  main() {
    if (!location.pathname.startsWith("/__tnu_fixture__/ai/")) return;
    browser.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
      const message = rawMessage as FixtureMessage;
      if (!message.type.startsWith("WEB_FIXTURE_")) return false;
      if (message.type === "WEB_FIXTURE_STATUS") {
        sendResponse({ ok: true, status: fixtureStatus(), conversationIdentity, latestResponseIdentity });
        return false;
      }
      if (message.type === "WEB_FIXTURE_PREPARE" && message.request) {
        void prepareRequest(message.request).then(sendResponse);
        return true;
      }
      if (message.type === "WEB_FIXTURE_SUBMIT" && message.requestId) {
        void submitRequest(message.requestId).then(sendResponse);
        return true;
      }
      if (message.type === "WEB_FIXTURE_WAIT" && message.requestId) {
        const existing = responses.get(message.requestId);
        if (existing) { sendResponse({ ok: true, response: existing }); return false; }
        const group = waiters.get(message.requestId) ?? [];
        group.push((response) => sendResponse({ ok: true, response }));
        waiters.set(message.requestId, group);
        return true;
      }
      if (message.type === "WEB_FIXTURE_CANCEL" && message.requestId) {
        generations.get(message.requestId)?.abort();
        generations.delete(message.requestId);
        const response: AIResponse = { requestId: message.requestId, executionEpoch: prepared?.executionEpoch ?? "", questionId: prepared?.questionId ?? "", conversationIdentity, responseIdentity: "cancelled", role: "assistant", complete: false, cancelled: true, content: "" };
        for (const resolve of waiters.get(message.requestId) ?? []) resolve(response);
        waiters.delete(message.requestId);
        return false;
      }
      if (message.type === "WEB_FIXTURE_NEW_CONVERSATION") {
        generations.forEach((generation) => generation.abort());
        generations.clear();
        conversationIdentity = `fixture-conversation-${crypto.randomUUID()}`;
        conversationGenerationCount += 1;
        fixtureRoot.dataset.fixtureConversationIdentity = conversationIdentity;
        fixtureRoot.dataset.fixtureConversationCount = String(conversationGenerationCount);
        prepared = undefined; responses.clear(); waiters.clear(); latestResponseIdentity = undefined;
        document.querySelector("#chat-messages")?.replaceChildren();
        sendResponse({ ok: true, conversationIdentity });
        return false;
      }
      if (message.type === "WEB_FIXTURE_CLEANUP") {
        prepared = undefined;
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });
  }
});
