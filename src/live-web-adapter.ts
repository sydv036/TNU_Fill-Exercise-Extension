import { RequestNotDispatchedError, type AIRequest, type AIResponse, type ProviderStatus, type WebAIAdapter } from "./web-adapter";
import type { WebProviderId } from "./types";
import { providerForWebUrl } from "./web-tabs";

interface LiveReply<T = unknown> {
  ok: boolean;
  error?: string;
  dispatched?: boolean;
  response?: T;
  status?: ProviderStatus;
  conversationIdentity?: string;
  latestResponseIdentity?: string;
}

export class LiveTabWebAdapter implements WebAIAdapter {
  constructor(readonly tabId: number, readonly providerId: WebProviderId) {}

  private async send<T>(message: Record<string, unknown>): Promise<LiveReply<T>> {
    const tab = await browser.tabs.get(this.tabId).catch(() => undefined);
    if (!tab?.id || !tab.url || providerForWebUrl(tab.url) !== this.providerId || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(tab.url)) {
      throw new Error("Tab AI thật đã đóng, đổi website hoặc không còn khớp provider.");
    }
    const reply = await browser.tabs.sendMessage(this.tabId, message) as LiveReply<T>;
    if (!reply?.ok) {
      const error = new Error(reply?.error || "AI Web content bridge không nhận request.");
      Object.assign(error, { dispatched: reply?.dispatched === true });
      throw error;
    }
    return reply;
  }

  async detect(): Promise<boolean> {
    const tab = await browser.tabs.get(this.tabId).catch(() => undefined);
    return Boolean(tab?.url && providerForWebUrl(tab.url) === this.providerId);
  }

  async checkReady(): Promise<ProviderStatus> {
    const reply = await this.send<never>({ type: "WEB_LIVE_STATUS" });
    return reply.status ?? { providerId: this.providerId, state: "unsupported", message: "Không đọc được trạng thái tab AI Web.", supportsImages: false, canAutomate: false };
  }

  async conversationIdentity(): Promise<string> {
    const reply = await this.send<never>({ type: "WEB_LIVE_STATUS" });
    if (!reply.conversationIdentity) throw new Error("Không xác định được cuộc trò chuyện AI Web hiện tại.");
    return reply.conversationIdentity;
  }

  async latestResponseIdentity(): Promise<string | undefined> {
    return (await this.send<never>({ type: "WEB_LIVE_STATUS" })).latestResponseIdentity;
  }

  async prepareInput(request: AIRequest): Promise<void> {
    await this.send({ type: "WEB_LIVE_PREPARE", request });
  }

  async submit(requestId: string): Promise<void> {
    try { await this.send({ type: "WEB_LIVE_SUBMIT", requestId }); }
    catch (error) {
      if (error instanceof Error && !(error as Error & { dispatched?: boolean }).dispatched) throw new RequestNotDispatchedError(error.message);
      throw error;
    }
  }

  async waitForResponse(requestId: string, signal: AbortSignal): Promise<AIResponse> {
    if (signal.aborted) throw new DOMException("Request đã bị hủy.", "AbortError");
    const pending = this.send<AIResponse>({ type: "WEB_LIVE_WAIT", requestId });
    const cancel = () => { void this.send({ type: "WEB_LIVE_CANCEL", requestId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const reply = await pending;
      if (!reply.response) throw new Error("AI Web bridge không trả về response.");
      return reply.response;
    } finally { signal.removeEventListener("abort", cancel); }
  }

  async createConversation(): Promise<void> {
    await this.send({ type: "WEB_LIVE_NEW_CONVERSATION" });
  }

  async cleanup(): Promise<void> {
    await this.send({ type: "WEB_LIVE_CLEANUP" }).catch(() => undefined);
  }
}

