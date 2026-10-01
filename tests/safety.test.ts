// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("submission safety", () => {
  const contentSource = readFileSync(new URL("../entrypoints/content.ts", import.meta.url), "utf8");
  const storageSource = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8");
  const panelSource = readFileSync(new URL("../entrypoints/sidepanel/App.tsx", import.meta.url), "utf8");

  it("does not target Moodle final-submit controls", () => {
    expect(contentSource).not.toMatch(/querySelector[^\n]*submitall/i);
    expect(contentSource).not.toMatch(/\.click\(\)[^\n]*submitall/i);
  });

  it("handles summary as a terminal state", () => {
    expect(contentSource).toContain('if (kind === "summary")');
    expect(contentSource).toContain('status: "completed"');
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
});
