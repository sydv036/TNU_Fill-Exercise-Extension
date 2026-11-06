import { RequestNotDispatchedError, type AIRequest, type AIResponse, type ProviderStatus, type WebAIAdapter } from "./web-adapter";
import type { WebProviderId } from "./types";
import { providerForWebUrl } from "./web-tabs";

interface FixtureReply<T = unknown> { ok: boolean; error?: string; response?: T; status?: ProviderStatus; conversationIdentity?: string; latestResponseIdentity?: string; }

function isFixtureUrl(value?: string): boolean {
  try {
    const url = new URL(value ?? "");
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:" && url.pathname.startsWith("/__tnu_fixture__/ai/");
  } catch { return false; }
}

export class FixtureTabWebAdapter implements WebAIAdapter {
  constructor(readonly tabId: number, readonly providerId: WebProviderId) {}

  private async send<T>(message: Record<string, unknown>): Promise<T> {
    const tab = await browser.tabs.get(this.tabId).catch(() => undefined);
    if (!tab?.id || !isFixtureUrl(tab.url) || providerForWebUrl(tab.url ?? "") !== this.providerId) throw new Error("Fixture tab identity changed or is no longer available.");
    const reply = await browser.tabs.sendMessage(this.tabId, message) as FixtureReply<T>;
    if (!reply?.ok) throw new Error(reply?.error || "Local Web fixture did not accept the request.");
    return (reply.response ?? reply) as T;
  }

  async detect(): Promise<boolean> {
    const tab = await browser.tabs.get(this.tabId).catch(() => undefined);
    return Boolean(tab?.url && isFixtureUrl(tab.url) && providerForWebUrl(tab.url) === this.providerId);
  }

  async checkReady(): Promise<ProviderStatus> {
    const reply = await this.send<never>({ type: "WEB_FIXTURE_STATUS" }) as unknown as FixtureReply;
    if (!reply.status) return { providerId: this.providerId, state: "unsupported", message: "Local fixture status is missing.", supportsImages: false, canAutomate: false };
    return reply.status;
  }

  async conversationIdentity(): Promise<string> {
    const reply = await this.send<never>({ type: "WEB_FIXTURE_STATUS" }) as unknown as FixtureReply;
    if (!reply.conversationIdentity) throw new Error("Fixture conversation identity is unavailable.");
    return reply.conversationIdentity;
  }

  async latestResponseIdentity(): Promise<string | undefined> {
    const reply = await this.send<never>({ type: "WEB_FIXTURE_STATUS" }) as unknown as FixtureReply;
    return reply.latestResponseIdentity;
  }

  async prepareInput(request: AIRequest): Promise<void> {
    await this.send({ type: "WEB_FIXTURE_PREPARE", request });
  }

  async submit(requestId: string): Promise<void> {
    try { await this.send({ type: "WEB_FIXTURE_SUBMIT", requestId }); }
    catch (error) {
      if (error instanceof Error && error.message.includes("Fixture rejected before dispatch")) throw new RequestNotDispatchedError(error.message);
      throw error;
    }
  }

  async waitForResponse(requestId: string, signal: AbortSignal): Promise<AIResponse> {
    if (signal.aborted) throw new DOMException("Request cancelled.", "AbortError");
    const wait = this.send<AIResponse>({ type: "WEB_FIXTURE_WAIT", requestId });
    const cancel = () => { void this.send({ type: "WEB_FIXTURE_CANCEL", requestId }).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try { return await wait; }
    finally { signal.removeEventListener("abort", cancel); }
  }

  async recoverResponse(request: AIRequest, timeoutMs: number): Promise<AIResponse | undefined> {
    return this.send<AIResponse | undefined>({ type: "WEB_FIXTURE_RECOVER", request, timeoutMs }).catch(() => undefined);
  }

  async createConversation(): Promise<void> {
    await this.send({ type: "WEB_FIXTURE_NEW_CONVERSATION" });
  }

  async cleanup(): Promise<void> {
    await this.send({ type: "WEB_FIXTURE_CLEANUP" }).catch(() => undefined);
  }
}

