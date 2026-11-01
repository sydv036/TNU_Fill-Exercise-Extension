import { describe, expect, it } from "vitest";
import { inferUniqueWebTabBinding, isBlankWebConversation, isWebProvider, providerForWebUrl, shouldInvalidateBindingForAiUrl, summarizeBrowserTabs, validateStoredBinding, validateWebTabBinding, webAutomationPolicy } from "../src/web-tabs";

const browserTabs = summarizeBrowserTabs([
  { id: 10, windowId: 1, title: "TNU quiz", url: "https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=9" },
  { id: 20, windowId: 2, title: "ChatGPT", url: "https://chatgpt.com/c/abc" },
  { id: 21, windowId: 2, title: "Claude", url: "https://claude.ai/new" },
  { id: 22, windowId: 3, title: "Gemini", url: "https://gemini.google.com/app" },
  { id: 23, windowId: 4, title: "Gemini local fixture", url: "http://127.0.0.1:4173/__tnu_fixture__/ai/gemini" },
  { id: 27, windowId: 5, title: "DeepSeek", url: "https://chat.deepseek.com/a/chat/s/abc" },
  { id: 24, windowId: 3, title: "Lookalike", url: "https://chatgpt.com.attacker.example/" },
  { id: 25, windowId: 3, title: "HTTP TNU", url: "http://tnu.aum.edu.vn/" },
  { id: 26, windowId: 3, title: "Other", url: "https://example.test/" }
]);

describe("multi-window AI tab binding", () => {
  it("enables the selected live Web providers and local fixtures", () => {
    expect(webAutomationPolicy("gemini_web")).toMatchObject({ integrationStatus: "ready", canAutomate: true });
    expect(webAutomationPolicy("chatgpt_web")).toMatchObject({ integrationStatus: "ready", canAutomate: true });
    expect(webAutomationPolicy("claude_web")).toMatchObject({ integrationStatus: "ready", canAutomate: true });
    expect(webAutomationPolicy("deepseek_web")).toMatchObject({ integrationStatus: "ready", canAutomate: true });
    expect(webAutomationPolicy("gemini_web", true)).toMatchObject({ integrationStatus: "ready", canAutomate: true });
  });

  it("recognizes only exact provider domains and keeps window/tab identities", () => {
    expect(providerForWebUrl("https://chatgpt.com/c/1")).toBe("chatgpt_web");
    expect(providerForWebUrl("https://chat.openai.com/" )).toBe("chatgpt_web");
    expect(providerForWebUrl("https://chatgpt.com.attacker.example/")).toBeUndefined();
    expect(providerForWebUrl("https://chat.deepseek.com/a/chat/s/abc")).toBe("deepseek_web");
    expect(providerForWebUrl("https://chat.deepseek.com.attacker.example/")).toBeUndefined();
    expect(browserTabs.map(({ id }) => id)).toEqual([10, 20, 21, 22, 23, 27]);
    expect(browserTabs[0]).toMatchObject({ kind: "tnu", windowId: 1, integrationStatus: "ready" });
    expect(browserTabs[2]).toMatchObject({ kind: "ai", providerId: "claude_web", integrationStatus: "ready" });
    expect(browserTabs[3]).toMatchObject({ kind: "ai", providerId: "gemini_web", integrationStatus: "ready" });
    expect(browserTabs[4]).toMatchObject({ kind: "ai", providerId: "gemini_web", integrationStatus: "ready", fixture: true });
    expect(browserTabs[5]).toMatchObject({ kind: "ai", providerId: "deepseek_web", integrationStatus: "ready" });
  });

  it("recognizes provider home pages as already blank conversations", () => {
    expect(isBlankWebConversation("chatgpt_web", "https://chatgpt.com/")).toBe(true);
    expect(isBlankWebConversation("chatgpt_web", "https://chatgpt.com/c/abc")).toBe(false);
    expect(isBlankWebConversation("gemini_web", "https://gemini.google.com/app")).toBe(true);
    expect(isBlankWebConversation("gemini_web", "https://gemini.google.com/app/abc")).toBe(false);
    expect(isBlankWebConversation("claude_web", "https://claude.ai/new")).toBe(true);
    expect(isBlankWebConversation("deepseek_web", "https://chat.deepseek.com/")).toBe(true);
    expect(isBlankWebConversation("deepseek_web", "https://chat.deepseek.com/a/chat/s/abc")).toBe(false);
  });

  it("binds a TNU tab and AI tab in different windows without depending on active tab", () => {
    const binding = validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 22, providerId: "gemini_web" });
    expect(binding).toMatchObject({ tnuTabId: 10, tnuWindowId: 1, aiTabId: 22, aiWindowId: 3, providerId: "gemini_web" });
    expect(isWebProvider(binding.providerId)).toBe(true);
    expect(validateStoredBinding(browserTabs, binding)).toEqual({ valid: true });
  });

  it("rejects a missing/closed tab, wrong provider, same tab, or changed window identity", () => {
    expect(() => validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 999, providerId: "chatgpt_web" })).toThrow(/đóng/);
    expect(() => validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 21, providerId: "chatgpt_web" })).toThrow(/không khớp/);
    expect(() => validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 10, providerId: "chatgpt_web" })).toThrow(/hai tab khác nhau/);
    const binding = validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 20, providerId: "chatgpt_web" });
    const moved = { ...binding, aiWindowId: 99 };
    expect(validateStoredBinding(browserTabs, moved)).toMatchObject({ valid: false, reason: expect.stringContaining("chuyển cửa sổ") });
  });

  it("invalidates a binding when a bound tab has reloaded onto an unrelated page", () => {
    const binding = validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 20, providerId: "chatgpt_web" });
    const reloadedTabs = summarizeBrowserTabs([
      { id: 10, windowId: 1, title: "TNU quiz", url: "https://tnu.aum.edu.vn/mod/quiz/attempt.php?attempt=9" },
      { id: 20, windowId: 2, title: "Changed", url: "https://example.test/" }
    ]);
    expect(validateStoredBinding(reloadedTabs, binding).valid).toBe(false);
  });

  it("automatically binds the selected TNU tab when exactly one provider tab exists", () => {
    const binding = inferUniqueWebTabBinding(browserTabs, { tnuTabId: 10, providerId: "gemini_web" });
    expect(binding).toMatchObject({ tnuTabId: 10, aiTabId: 22, providerId: "gemini_web" });
  });

  it("requires an explicit choice when several tabs use the same provider", () => {
    const duplicated = [...browserTabs, { ...browserTabs.find((tab) => tab.id === 22)!, id: 23 }];
    expect(() => inferUniqueWebTabBinding(duplicated, { tnuTabId: 10, providerId: "gemini_web" }))
      .toThrow("Có nhiều tab AI Web cùng provider");
  });

  it("keeps binding when Gemini creates a conversation URL in the same tab", () => {
    const binding = validateWebTabBinding(browserTabs, { tnuTabId: 10, aiTabId: 22, providerId: "gemini_web" });
    expect(shouldInvalidateBindingForAiUrl(binding, 22, "https://gemini.google.com/app/d6817905a876c4c2")).toBe(false);
    expect(shouldInvalidateBindingForAiUrl(binding, 22, "https://example.com/")).toBe(true);
    expect(shouldInvalidateBindingForAiUrl(binding, 99, "https://example.com/")).toBe(false);
  });
});
