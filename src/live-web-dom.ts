import type { WebProviderId } from "./types";

export interface LiveWebDomProfile {
  editorSelectors: readonly string[];
  sendSelectors: readonly string[];
  stopSelectors: readonly string[];
  assistantSelectors: readonly string[];
  userSelectors: readonly string[];
  newChatSelectors: readonly string[];
  fileInputSelectors: readonly string[];
}

export const LIVE_WEB_DOM_PROFILES: Record<WebProviderId, LiveWebDomProfile> = {
  gemini_web: {
    editorSelectors: [
      '[contenteditable="true"][role="textbox"][aria-label*="Gemini" i]',
      '.ql-editor[contenteditable="true"][role="textbox"]'
    ],
    sendSelectors: ['button[aria-label*="Gửi" i]', 'button[aria-label*="Send" i]', 'button.send-button'],
    stopSelectors: ['button[aria-label*="Dừng" i]', 'button[aria-label*="Stop" i]', 'button.stop-button'],
    assistantSelectors: ['model-response'],
    userSelectors: ['user-query'],
    newChatSelectors: ['a[href="/app"]', 'a[href^="/app?"]', 'button[aria-label*="Cuộc trò chuyện mới" i]', 'button[aria-label*="New chat" i]'],
    fileInputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]']
  },
  chatgpt_web: {
    editorSelectors: ['#prompt-textarea', '[contenteditable="true"][role="textbox"][data-composer-markdown]', '[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i]'],
    sendSelectors: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Gửi" i]'],
    stopSelectors: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="Dừng" i]'],
    assistantSelectors: ['[data-message-author-role="assistant"]', '[data-turn="assistant"]'],
    userSelectors: ['[data-message-author-role="user"]', '[data-turn="user"]'],
    newChatSelectors: ['a[data-testid="create-new-chat-button"]', 'a[href="/"]', 'button[aria-label*="New chat" i]', 'button[aria-label*="Trò chuyện mới" i]'],
    fileInputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]']
  },
  claude_web: {
    editorSelectors: ['[contenteditable="true"][role="textbox"]', 'div.ProseMirror[contenteditable="true"]', 'textarea[placeholder*="Claude" i]'],
    sendSelectors: ['button[aria-label*="Send" i]', 'button[aria-label*="Gửi" i]', 'button[data-testid="send-button"]'],
    stopSelectors: ['button[aria-label*="Stop" i]', 'button[aria-label*="Dừng" i]', 'button[data-testid*="stop" i]'],
    assistantSelectors: ['[data-testid="assistant-message"]', '[data-message-author-role="assistant"]', '.font-claude-response', '[data-is-streaming]'],
    userSelectors: ['[data-testid="user-message"]', '[data-message-author-role="user"]'],
    newChatSelectors: ['a[href="/new"]', 'button[aria-label*="New chat" i]', 'button[aria-label*="Trò chuyện mới" i]'],
    fileInputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]']
  },
  deepseek_web: {
    // DeepSeek currently uses a native textarea. Prefer semantic attributes and
    // stable design-system classes; hashed bundle classes are intentionally avoided.
    editorSelectors: ['textarea[placeholder*="DeepSeek" i]', 'textarea[name="search"][autocomplete="off"]'],
    sendSelectors: ['[role="button"].ds-button--primary.ds-button--filled.ds-button--circle:not(.ds-button--disabled)'],
    stopSelectors: ['[role="button"].ds-button--primary.ds-button--filled.ds-button--circle:not(.ds-button--disabled)'],
    assistantSelectors: ['.ds-message:has(.ds-assistant-message-main-content)', '.ds-assistant-message-main-content'],
    userSelectors: ['.ds-message:has(.ds-collapsible-text):not(:has(.ds-assistant-message-main-content))'],
    // On the current responsive DeepSeek header the new-chat control is the
    // 44px XL icon button with an explicit min-width. The generic M buttons
    // include off-canvas sidebar controls and can silently click the wrong UI.
    newChatSelectors: ['[role="button"].ds-button--xl[style*="min-width"]'],
    fileInputSelectors: ['input[type="file"][accept*="image"]', 'input[type="file"]']
  }
};

function chatGptTurnFromHeading(heading: Element, role: "assistant" | "user"): HTMLElement | undefined {
  const label = (heading.textContent || "").replace(/\s+/g, " ").trim();
  const matches = role === "assistant"
    ? /^(?:chatgpt|assistant)\s*(?:đã nói|said)\s*:?$/i.test(label)
    : /^(?:bạn|you)\s*(?:đã nói|said)\s*:?$/i.test(label);
  if (!matches) return undefined;
  return heading.closest<HTMLElement>('article, [data-testid^="conversation-turn-"], [data-turn]')
    ?? heading.parentElement?.parentElement
    ?? heading.parentElement
    ?? undefined;
}

function chatGptSemanticTurns(role: "assistant" | "user", root: ParentNode): HTMLElement[] {
  const turns: HTMLElement[] = [];
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="sr-only"], [class*="visually-hidden"]')) {
    const turn = chatGptTurnFromHeading(heading, role);
    if (turn && !turns.includes(turn)) turns.push(turn);
  }
  return turns;
}

function correlatedJsonObject(text: string, requestId: string, questionId: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const character = text[end]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth++;
      if (character !== "}") continue;
      depth--;
      if (depth !== 0) continue;
      const candidate = text.slice(start, end + 1);
      try {
        const value = JSON.parse(candidate) as Record<string, unknown>;
        if (value.requestId === requestId && value.questionId === questionId
          && Array.isArray(value.selectedOptionIds) && typeof value.confidence === "number"
          && typeof value.needsHumanReview === "boolean") return candidate;
      } catch { /* A surrounding element can contain non-JSON braces; keep scanning. */ }
      break;
    }
  }
  return undefined;
}

export function findCorrelatedLiveResponse(
  provider: WebProviderId,
  requestId: string,
  questionId: string,
  root: ParentNode = document
): { element: HTMLElement; content: string } | undefined {
  if (provider !== "chatgpt_web" && provider !== "deepseek_web") return undefined;
  const selector = [
    '[data-message-author-role="assistant"]', '[data-turn="assistant"]',
    'article', '[data-testid^="conversation-turn-"]',
    'main [class~="markdown"]', 'main [class*="markdown"]',
    'main pre', 'main code', 'main div',
    '.ds-message', '.ds-assistant-message-main-content', '.ds-markdown'
  ].join(",");
  const candidates = [...root.querySelectorAll<HTMLElement>(selector)]
    .map((element) => ({ element, text: liveResponseText(element) }))
    .filter(({ text }) => text.includes(requestId) && text.includes(questionId) && text.includes("selectedOptionIds"))
    .sort((left, right) => left.text.length - right.text.length);
  for (const { element, text } of candidates) {
    const content = correlatedJsonObject(text, requestId, questionId);
    if (content) return { element, content };
  }
  return undefined;
}

function firstVisible<T extends Element>(selectors: readonly string[], root: ParentNode = document): T | undefined {
  for (const selector of selectors) {
    for (const candidate of root.querySelectorAll<T>(selector)) {
      const element = candidate as unknown as HTMLElement;
      if (!element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length) return candidate;
    }
  }
  return undefined;
}

export function findLiveEditor(provider: WebProviderId, root: ParentNode = document): HTMLElement | undefined {
  return firstVisible<HTMLElement>(LIVE_WEB_DOM_PROFILES[provider].editorSelectors, root);
}

export function findLiveSendButton(provider: WebProviderId, root: ParentNode = document): HTMLElement | undefined {
  return firstVisible<HTMLElement>(LIVE_WEB_DOM_PROFILES[provider].sendSelectors, root);
}

export function findLiveStopButton(provider: WebProviderId, root: ParentNode = document): HTMLElement | undefined {
  if (provider === "deepseek_web") {
    const editor = findLiveEditor(provider, root);
    if (editor instanceof HTMLTextAreaElement && editor.value.trim()) return undefined;
  }
  return firstVisible<HTMLElement>(LIVE_WEB_DOM_PROFILES[provider].stopSelectors, root);
}

export function findLiveFileInput(provider: WebProviderId, root: ParentNode = document): HTMLInputElement | undefined {
  for (const selector of LIVE_WEB_DOM_PROFILES[provider].fileInputSelectors) {
    const input = root.querySelector<HTMLInputElement>(selector);
    if (input && !input.disabled) return input;
  }
  return undefined;
}

export function liveAssistantMessages(provider: WebProviderId, root: ParentNode = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const result: HTMLElement[] = [];
  for (const selector of LIVE_WEB_DOM_PROFILES[provider].assistantSelectors) {
    for (const item of root.querySelectorAll<HTMLElement>(selector)) {
      const nestedInKnown = result.some((known) => known.contains(item));
      if (seen.has(item) || nestedInKnown) continue;
      seen.add(item); result.push(item);
    }
  }
  if (provider === "chatgpt_web") {
    for (const item of chatGptSemanticTurns("assistant", root)) {
      if (seen.has(item) || result.some((known) => known.contains(item) || item.contains(known))) continue;
      seen.add(item); result.push(item);
    }
  }
  return result;
}

export function liveUserMessageCount(provider: WebProviderId, root: ParentNode = document): number {
  const selectors = LIVE_WEB_DOM_PROFILES[provider].userSelectors.join(",");
  const explicit = selectors ? [...root.querySelectorAll<HTMLElement>(selectors)] : [];
  if (provider !== "chatgpt_web") return explicit.length;
  const semantic = chatGptSemanticTurns("user", root);
  const unique = [...explicit];
  for (const item of semantic) {
    if (!unique.some((known) => known === item || known.contains(item) || item.contains(known))) unique.push(item);
  }
  return unique.length;
}

export function liveResponseText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim();
}

export function isLiveGenerating(provider: WebProviderId, response?: HTMLElement, root: ParentNode = document): boolean {
  if (findLiveStopButton(provider, root)) return true;
  if (response?.matches('[aria-busy="true"], [data-is-streaming="true"], .streaming')) return true;
  return Boolean(response?.querySelector('[aria-busy="true"], [data-is-streaming="true"], .streaming'));
}

export function findNewChatControl(provider: WebProviderId, root: ParentNode = document): HTMLElement | undefined {
  const profile = LIVE_WEB_DOM_PROFILES[provider];
  for (const selector of profile.newChatSelectors) {
    const matches = [...root.querySelectorAll<HTMLElement>(selector)];
    if (provider === "deepseek_web" && matches.length) return matches[0];
    const named = matches.find((item) => /new chat|trò chuyện mới|đoạn chat mới/i.test([item.getAttribute("aria-label"), item.getAttribute("title"), item.textContent].filter(Boolean).join(" ")));
    if (named) return named;
    if (matches.length === 1 && (selector.includes('href="/"') || selector.includes('href="/app"') || selector.includes('href="/new"'))) return matches[0];
  }
  return undefined;
}

