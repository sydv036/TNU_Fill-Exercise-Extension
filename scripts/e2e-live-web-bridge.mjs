import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extension = path.resolve(process.env.TNU_E2E_EXTENSION || "release/v3.3.1/chrome-mv3");
const browserPath = process.env.TNU_E2E_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = await mkdtemp(path.join(tmpdir(), "tnu-live-web-bridge-"));
let context;

const providerCases = [
  { id: "gemini_web", url: "https://gemini.google.com/app", editor: '<div class="ql-editor" contenteditable="true" role="textbox" aria-label="Nhập câu lệnh cho Gemini"></div>', send: '<button aria-label="Gửi tin nhắn">Send</button>', userTag: "user-query", assistantTag: "model-response" },
  { id: "chatgpt_web", url: "https://chatgpt.com/", editor: '<div contenteditable="true" role="textbox" data-composer-markdown aria-label="Hỏi ChatGPT"></div>', send: '<button data-testid="send-button">Send</button>', userTag: "article", userAttrs: 'data-message-author-role="user"', assistantTag: "article", assistantAttrs: 'data-message-author-role="assistant"' },
  { id: "claude_web", url: "https://claude.ai/new", editor: '<div class="ProseMirror" contenteditable="true" role="textbox"></div>', send: '<button aria-label="Send message">Send</button>', userTag: "div", userAttrs: 'data-testid="user-message"', assistantTag: "div", assistantAttrs: 'data-testid="assistant-message"' },
  { id: "deepseek_web", url: "https://chat.deepseek.com/", editor: '<textarea placeholder="Nhắn tin cho DeepSeek" name="search" autocomplete="off"></textarea>', send: '<div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle" tabindex="0">Send</div>', userTag: "div", userAttrs: 'class="ds-message ds-user-message"', assistantTag: "div", assistantAttrs: 'class="ds-message ds-assistant-message-main-content"' }
];

function html(item) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:20px}[contenteditable],textarea,button,[role=button]{display:block;width:600px;min-height:40px;margin:10px}</style></head><body><a href="${item.id === "gemini_web" ? "/app" : item.id === "claude_web" ? "/new" : "/"}" aria-label="New chat">New chat</a>${item.editor}${item.send}<main id="messages"></main><script>
  const editor=document.querySelector('[contenteditable="true"],textarea'); const send=document.querySelector('button,[role="button"]');
  send.addEventListener('click',()=>{ const prompt='value' in editor?editor.value:(editor.innerText||editor.textContent||''); const user=document.createElement('${item.userTag}'); ${item.userAttrs ? `user.setAttribute('${item.userAttrs.split('=')[0]}','${item.userAttrs.match(/"([^"]+)"/)?.[1]}');` : ""} user.textContent=prompt; document.querySelector('#messages').append(user); if('value' in editor) editor.value=''; else editor.replaceChildren(); const response=document.createElement('${item.assistantTag}'); ${item.assistantAttrs ? `response.setAttribute('${item.assistantAttrs.split('=')[0]}','${item.assistantAttrs.match(/"([^"]+)"/)?.[1]}');` : ""} response.setAttribute('aria-busy','true'); response.textContent='streaming'; document.querySelector('#messages').append(response); setTimeout(()=>{response.textContent=JSON.stringify({requestId:'request-1',questionId:'question-1',selectedOptionIds:['option_1'],confidence:.96,reason:'bridge e2e',needsHumanReview:false});response.removeAttribute('aria-busy'); if('${item.id}'==='deepseek_web') send.classList.add('ds-button--disabled')},350); });
  </script></body></html>`;
}

try {
  context = await chromium.launchPersistentContext(profile, { executablePath: browserPath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  for (const item of providerCases) {
    await context.route(`${new URL(item.url).origin}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html(item) }));
    const page = await context.newPage();
    await page.goto(item.url);
    const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url: `${new URL(url).origin}/*` })).at(-1)?.id, item.url);
    if (typeof tabId !== "number") throw new Error(`${item.id}: cannot find provider tab.`);
    const initial = await panel.evaluate(async ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: "WEB_LIVE_STATUS" }), { tabId });
    if (!initial.ok || initial.status?.state !== "ready" || !initial.conversationIdentity) throw new Error(`${item.id}: content bridge is not ready: ${JSON.stringify(initial)}`);
    const request = { sessionId: "session-1", requestId: "request-1", executionEpoch: "epoch-1", questionId: "question-1", providerId: item.id, conversationIdentity: initial.conversationIdentity, prompt: `Prompt ${item.id}`, timeoutMs: 10000, question: { id: "question-1", number: "1", type: "single", prompt: "2 + 2", images: [], options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }] } };
    const prepared = await panel.evaluate(async ({ tabId, request }) => chrome.tabs.sendMessage(tabId, { type: "WEB_LIVE_PREPARE", request }), { tabId, request });
    if (!prepared.ok) throw new Error(`${item.id}: prepare failed: ${prepared.error}`);
    const editorText = item.id === "deepseek_web" ? await page.locator("textarea").inputValue() : await page.locator('[contenteditable="true"]').innerText();
    if (!editorText.includes(item.id)) throw new Error(`${item.id}: prompt was not placed in editor.`);
    const submitted = await panel.evaluate(async ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: "WEB_LIVE_SUBMIT", requestId: "request-1" }), { tabId });
    if (!submitted.ok || !submitted.dispatched) throw new Error(`${item.id}: submit failed: ${JSON.stringify(submitted)}`);
    const completed = await panel.evaluate(async ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: "WEB_LIVE_WAIT", requestId: "request-1" }), { tabId });
    if (!completed.ok || !completed.response?.complete || !completed.response?.content.includes('"requestId":"request-1"')) throw new Error(`${item.id}: response correlation failed: ${JSON.stringify(completed)}`);
    await panel.evaluate(async ({ tabId }) => chrome.tabs.sendMessage(tabId, { type: "WEB_LIVE_CLEANUP" }), { tabId });
    await page.close();
  }
  console.log("PASS: live content bridge prepared, submitted and correlated completed responses for Gemini, ChatGPT, Claude and DeepSeek DOM fixtures; no provider network request was made.");
} finally {
  await context?.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

