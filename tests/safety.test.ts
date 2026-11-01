// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("submission safety", () => {
  const contentSource = readFileSync(new URL("../entrypoints/content.ts", import.meta.url), "utf8");
  const storageSource = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../entrypoints/sidepanel/App.tsx", import.meta.url), "utf8");
  const backgroundSource = readFileSync(new URL("../entrypoints/background.ts", import.meta.url), "utf8");
  const typesSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");

  it("does not target Moodle final-submit controls", () => {
    expect(contentSource).not.toMatch(/querySelector[^\n]*submitall/i);
    expect(contentSource).not.toMatch(/\.click\(\)[^\n]*submitall/i);
    expect(contentSource).not.toContain("document.querySelector<HTMLElement>('button[type=\"submit\"], input[type=\"submit\"]')");
  });

  it("handles summary as a terminal state", () => {
    expect(contentSource).toContain('if (kind === "summary")');
    expect(contentSource).toContain('status: inBatch ? "awaiting_user" : "completed"');
    expect(contentSource).toContain("Extension đã dừng ở trang tổng kết và chưa nộp bài.");
  });

  it("shows the current question without persisting image base64 in session state", () => {
    expect(contentSource).toContain("currentQuestionSnapshot: { ...question, images: [] }");
    expect(panelSource).toContain("run.currentQuestionSnapshot");
    expect(panelSource).toContain("visibleQuestion.prompt");
  });

  it("resets both persistent and session extension storage", () => {
    expect(storageSource).toContain("browser.storage.local.clear()");
    expect(storageSource).toContain("browser.storage.session.clear()");
  });

  it("requires an agreed independent check before applying a graded answer", () => {
    expect(backgroundSource).toContain('assessmentKind !== "practice"');
    expect(backgroundSource).toContain('["agreed", "user_confirmed"]');
    expect(backgroundSource).toContain("Bài kiểm tra chỉ được áp dụng sau khi kiểm tra kép đồng thuận.");
  });

  it("ties every content-script run update to the session that produced it", () => {
    const updates = contentSource.match(/type:\s*"UPDATE_RUN"/g) ?? [];
    const guardedUpdates = contentSource.match(/type:\s*"UPDATE_RUN",\s*runId:/g) ?? [];
    expect(guardedUpdates).toHaveLength(updates.length);
  });

  it("keeps API key values out of runtime message schemas and content code", () => {
    expect(typesSource).not.toContain('type: "SAVE_API_KEY"');
    expect(typesSource).not.toContain('type: "SAVE_PROVIDER_KEY"');
    expect(typesSource).not.toContain('apiKey: string');
    expect(contentSource).not.toMatch(/storage\.(local|sync)/);
    expect(contentSource).not.toMatch(/geminiApiKey|openaiApiKey|anthropicApiKey/);
    expect(panelSource).not.toMatch(/runtime\(\{[^}]*apiKey\s*:/s);
    expect(storageSource).toContain("accessLevel: \"TRUSTED_CONTEXTS\"");
    expect(backgroundSource).toContain("EXTENSION_ONLY_TYPES.has(message.type)");
  });

  it("does not write keys to synchronized storage or log provider response bodies", () => {
    expect(storageSource).not.toContain("storage.sync");
    expect(backgroundSource).not.toContain("console.log");
    expect(backgroundSource).not.toContain("apiKey: message.apiKey");
  });
});
