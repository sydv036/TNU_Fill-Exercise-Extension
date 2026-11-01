import { beforeEach, describe, expect, it } from "vitest";
import { findCorrelatedLiveResponse, findLiveEditor, findLiveSendButton, findNewChatControl, isLiveGenerating, liveAssistantMessages, liveResponseText, liveUserMessageCount } from "../src/live-web-dom";

function visible(element: Element): void {
  Object.defineProperty(element, "getClientRects", { configurable: true, value: () => [{ width: 1, height: 1 }] });
}

describe("live AI Web DOM profiles", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("detects current Gemini editor, send/stop controls and model response", () => {
    document.body.innerHTML = '<a href="/app" aria-label="Cuộc trò chuyện mới"></a><div class="ql-editor" contenteditable="true" role="textbox" aria-label="Nhập câu lệnh cho Gemini"></div><button aria-label="Gửi tin nhắn"></button><model-response aria-busy="true"><div>{"ok":true}</div></model-response>';
    document.querySelectorAll("*").forEach(visible);
    expect(findLiveEditor("gemini_web")).toBeTruthy();
    expect(findLiveSendButton("gemini_web")).toBeTruthy();
    expect(findNewChatControl("gemini_web")).toBeTruthy();
    const response = liveAssistantMessages("gemini_web")[0];
    expect(liveResponseText(response!)).toContain("ok");
    expect(isLiveGenerating("gemini_web", response)).toBe(true);
  });

  it("detects current ChatGPT composer and correlated assistant messages", () => {
    document.body.innerHTML = '<a href="/" aria-label="Trò chuyện mới"></a><div contenteditable="true" role="textbox" data-composer-markdown aria-label="Hỏi ChatGPT"></div><button data-testid="send-button"></button><article data-message-author-role="assistant" data-message-id="m1">answer</article>';
    document.querySelectorAll("*").forEach(visible);
    expect(findLiveEditor("chatgpt_web")).toBeTruthy();
    expect(findLiveSendButton("chatgpt_web")).toBeTruthy();
    expect(liveAssistantMessages("chatgpt_web")).toHaveLength(1);
  });

  it("detects the current ChatGPT turn markup through data-turn", () => {
    document.body.innerHTML = '<main><article data-testid="conversation-turn-1" data-turn="user"><h6>Bạn đã nói:</h6><div>question</div></article><article data-testid="conversation-turn-2" data-turn="assistant"><h6>ChatGPT đã nói:</h6><div>{"requestId":"r1"}</div></article></main>';
    expect(liveUserMessageCount("chatgpt_web")).toBe(1);
    expect(liveAssistantMessages("chatgpt_web")).toHaveLength(1);
    expect(liveResponseText(liveAssistantMessages("chatgpt_web")[0]!)).toContain('"requestId":"r1"');
  });

  it("falls back to ChatGPT accessibility headings when role attributes are absent", () => {
    document.body.innerHTML = '<main><article data-testid="conversation-turn-1"><h6>Bạn đã nói:</h6><div>question</div></article><article data-testid="conversation-turn-2"><h6>ChatGPT đã nói:</h6><div>{"requestId":"r2"}</div><button>Sao chép</button></article></main>';
    expect(liveUserMessageCount("chatgpt_web")).toBe(1);
    const responses = liveAssistantMessages("chatgpt_web");
    expect(responses).toHaveLength(1);
    expect(liveResponseText(responses[0]!)).toContain('"requestId":"r2"');
  });

  it("finds a correlated ChatGPT JSON response without message role markup", () => {
    const requestId = "80deac13-2326-4148-b49c-c6086815eb11";
    document.body.innerHTML = `<main><div class="prompt">Request ID: ${requestId}<br>Question ID: q-4<br>{"requestId":"...","questionId":"...","selectedOptionIds":["option_0"],"confidence":0.8,"needsHumanReview":false}</div><section><div class="markdown prose">{"requestId":"${requestId}","questionId":"q-4","selectedOptionIds":["option_1"],"confidence":1,"reason":"ok","needsHumanReview":false}</div></section></main>`;
    const result = findCorrelatedLiveResponse("chatgpt_web", requestId, "q-4");
    expect(result?.content).toContain(`"requestId":"${requestId}"`);
    expect(result?.content).toContain('"selectedOptionIds":["option_1"]');
  });

  it("does not mistake the JSON schema in the user prompt for a response", () => {
    const requestId = "r-schema-only";
    document.body.innerHTML = `<main><div>Request ID: ${requestId}<br>Question ID: q-1<br>{"requestId":"...","questionId":"...","selectedOptionIds":["option_0"],"confidence":0.8,"needsHumanReview":false}</div></main>`;
    expect(findCorrelatedLiveResponse("chatgpt_web", requestId, "q-1")).toBeUndefined();
  });

  it("does not accept a temporarily stable but incomplete ChatGPT JSON stream", () => {
    const requestId = "streaming-request";
    const response = document.createElement("article");
    response.dataset.turn = "assistant";
    response.textContent = `{"requestId":"${requestId}","questionId":"q-stream","selectedOptionIds":["option_3"]`;
    document.body.append(response);
    expect(findCorrelatedLiveResponse("chatgpt_web", requestId, "q-stream")).toBeUndefined();

    response.textContent = `{"requestId":"${requestId}","questionId":"q-stream","selectedOptionIds":["option_3"],"confidence":0.99,"reason":"ok","needsHumanReview":false}`;
    expect(findCorrelatedLiveResponse("chatgpt_web", requestId, "q-stream")?.content).toBe(response.textContent);
  });

  it("detects Claude editor while keeping provider selectors isolated", () => {
    document.body.innerHTML = '<a href="/new" aria-label="New chat"></a><div class="ProseMirror" contenteditable="true" role="textbox"></div><button aria-label="Send message"></button><div data-testid="assistant-message">reply</div>';
    document.querySelectorAll("*").forEach(visible);
    expect(findLiveEditor("claude_web")).toBeTruthy();
    expect(findLiveSendButton("claude_web")).toBeTruthy();
    expect(liveAssistantMessages("claude_web")[0]?.textContent).toBe("reply");
  });

  it("detects the current DeepSeek textarea, controls, messages and complete correlated JSON", () => {
    const requestId = "deepseek-request";
    document.body.innerHTML = `<div role="button" class="ds-button ds-button--xl" style="min-width: 44px"></div><textarea placeholder="Nhắn tin cho DeepSeek" name="search" autocomplete="off"></textarea><div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle"></div><div class="ds-message"><div class="ds-collapsible-text">question</div></div><div class="ds-message"><div class="ds-markdown ds-assistant-message-main-content">{"requestId":"${requestId}","questionId":"q-deepseek","selectedOptionIds":["option_1"],"confidence":0.98,"reason":"ok","needsHumanReview":false}</div></div>`;
    document.querySelectorAll("*").forEach(visible);
    expect(findLiveEditor("deepseek_web")).toBeTruthy();
    expect(findLiveSendButton("deepseek_web")).toBeTruthy();
    expect(findNewChatControl("deepseek_web")).toBeTruthy();
    expect(liveUserMessageCount("deepseek_web")).toBe(1);
    expect(liveAssistantMessages("deepseek_web")).toHaveLength(1);
    expect(findCorrelatedLiveResponse("deepseek_web", requestId, "q-deepseek")?.content).toContain('"selectedOptionIds":["option_1"]');
  });

  it("does not accept an incomplete DeepSeek JSON stream", () => {
    const requestId = "deepseek-stream";
    document.body.innerHTML = `<div class="ds-message"><div class="ds-assistant-message-main-content">{"requestId":"${requestId}","questionId":"q-stream","selectedOptionIds":["option_2"]</div></div>`;
    expect(findCorrelatedLiveResponse("deepseek_web", requestId, "q-stream")).toBeUndefined();
  });
});
