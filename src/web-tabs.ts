import type { BrowserTabSummary, ProviderId, WebProviderId, WebTabBinding } from "./types";

export interface WebAutomationPolicy {
  integrationStatus: BrowserTabSummary["integrationStatus"];
  canAutomate: boolean;
  reason: string;
}

export function webAutomationPolicy(provider: WebProviderId, fixture = false): WebAutomationPolicy {
  if (fixture) return { integrationStatus: "ready", canAutomate: true, reason: "Local AI fixture is available for isolated tests." };
  const label = provider === "gemini_web" ? "Gemini Web" : provider === "chatgpt_web" ? "ChatGPT Web" : provider === "deepseek_web" ? "DeepSeek Web" : "Claude Web";
  return { integrationStatus: "ready", canAutomate: true, reason: `${label}: content bridge sẵn sàng kiểm tra editor, gửi prompt và nhận phản hồi trong tab đã bind.` };
}

const WEB_HOSTS: Record<WebProviderId, readonly string[]> = {
  chatgpt_web: ["chatgpt.com", "chat.openai.com"],
  claude_web: ["claude.ai"],
  gemini_web: ["gemini.google.com"],
  deepseek_web: ["chat.deepseek.com"]
};

export function providerForWebUrl(value: string): WebProviderId | undefined {
  let host: string;
  let url: URL;
  try { url = new URL(value); host = url.hostname.toLowerCase(); } catch { return undefined; }
  if ((host === "127.0.0.1" || host === "localhost") && url.protocol === "http:") {
    const fixture = url.pathname.match(/^\/__tnu_fixture__\/ai\/(chatgpt|claude|gemini|deepseek)(?:\/|$)/);
    if (fixture) return ({ chatgpt: "chatgpt_web", claude: "claude_web", gemini: "gemini_web", deepseek: "deepseek_web" } as const)[fixture[1] as "chatgpt" | "claude" | "gemini" | "deepseek"];
  }
  return (Object.entries(WEB_HOSTS) as Array<[WebProviderId, readonly string[]]>).find(([, hosts]) => hosts.includes(host))?.[0];
}

export function isBlankWebConversation(provider: WebProviderId, value: string): boolean {
  try {
    const url = new URL(value);
    if (providerForWebUrl(value) !== provider) return false;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (provider === "chatgpt_web") return pathname === "/";
    if (provider === "gemini_web") return pathname === "/app";
    if (provider === "deepseek_web") return pathname === "/";
    return pathname === "/new" || pathname === "/";
  } catch { return false; }
}

function isFixtureUrl(value: string): boolean {
  try { const url = new URL(value); return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:" && /^\/__tnu_fixture__\/ai\/(?:chatgpt|claude|gemini|deepseek)(?:\/|$)/.test(url.pathname); }
  catch { return false; }
}

export function isTnuUrl(value: string): boolean {
  try { return new URL(value).hostname.toLowerCase() === "tnu.aum.edu.vn" && new URL(value).protocol === "https:"; }
  catch { return false; }
}

export function summarizeBrowserTabs(tabs: Array<{ id?: number; windowId?: number; title?: string; url?: string }>): BrowserTabSummary[] {
  const summaries: BrowserTabSummary[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number" || !tab.url) continue;
    let domain: string;
    try { domain = new URL(tab.url).hostname.toLowerCase(); } catch { continue; }
    if (isTnuUrl(tab.url)) {
      summaries.push({ id: tab.id, windowId: tab.windowId, title: tab.title || domain, url: tab.url, domain, kind: "tnu", integrationStatus: "ready" });
      continue;
    }
    const providerId = providerForWebUrl(tab.url);
    if (!providerId) continue;
    const fixture = isFixtureUrl(tab.url);
    summaries.push({ id: tab.id, windowId: tab.windowId, title: tab.title || domain, url: tab.url, domain, kind: "ai", providerId, integrationStatus: webAutomationPolicy(providerId, fixture).integrationStatus, fixture });
  }
  return summaries;
}

export function validateWebTabBinding(
  tabs: BrowserTabSummary[],
  selection: { tnuTabId: number; aiTabId: number; providerId: WebProviderId }
): WebTabBinding {
  if (selection.tnuTabId === selection.aiTabId) throw new Error("Chọn hai tab khác nhau: một tab TNU và một tab AI.");
  const tnu = tabs.find((tab) => tab.id === selection.tnuTabId && tab.kind === "tnu");
  if (!tnu) throw new Error("Tab TNU đã đóng, tải lại hoặc không còn thuộc miền TNU hợp lệ.");
  const ai = tabs.find((tab) => tab.id === selection.aiTabId && tab.kind === "ai");
  if (!ai) throw new Error("Tab AI đã đóng hoặc website không được nhận diện.");
  if (ai.providerId !== selection.providerId) throw new Error("Provider không khớp với website của tab AI đã chọn.");
  return {
    tnuTabId: tnu.id,
    tnuWindowId: tnu.windowId,
    aiTabId: ai.id,
    aiWindowId: ai.windowId,
    providerId: selection.providerId,
    fixture: ai.fixture === true,
    boundAt: new Date().toISOString()
  };
}

export function inferUniqueWebTabBinding(
  tabs: BrowserTabSummary[],
  selection: { tnuTabId: number; providerId: WebProviderId }
): WebTabBinding {
  const tnu = tabs.find((tab) => tab.id === selection.tnuTabId && tab.kind === "tnu");
  if (!tnu) throw new Error("Tab TNU đang chạy không còn hợp lệ.");
  const providerTabs = tabs.filter((tab) => tab.kind === "ai" && tab.providerId === selection.providerId);
  const liveTabs = providerTabs.filter((tab) => tab.fixture !== true);
  const candidates = liveTabs.length ? liveTabs : providerTabs;
  if (candidates.length === 0) throw new Error("Không tìm thấy tab AI Web đúng provider. Hãy mở tab AI, đăng nhập rồi thử lại.");
  if (candidates.length > 1) throw new Error("Có nhiều tab AI Web cùng provider. Hãy chọn chính xác tab cần dùng và bấm Liên kết hai tab.");
  return validateWebTabBinding(tabs, {
    tnuTabId: tnu.id,
    aiTabId: candidates[0]!.id,
    providerId: selection.providerId
  });
}

export function validateStoredBinding(tabs: BrowserTabSummary[], binding: WebTabBinding): { valid: boolean; reason?: string } {
  try {
    const current = validateWebTabBinding(tabs, binding);
    if (current.tnuWindowId !== binding.tnuWindowId || current.aiWindowId !== binding.aiWindowId || current.fixture !== (binding.fixture === true)) return { valid: false, reason: "Tab đã chuyển cửa sổ hoặc đổi loại kết nối; hãy bind lại để xác nhận danh tính phiên." };
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function shouldInvalidateBindingForAiUrl(binding: WebTabBinding, tabId: number, url: string): boolean {
  return binding.aiTabId === tabId && providerForWebUrl(url) !== binding.providerId;
}

export function isWebProvider(provider: ProviderId): provider is WebProviderId {
  return provider === "chatgpt_web" || provider === "claude_web" || provider === "gemini_web" || provider === "deepseek_web";
}

