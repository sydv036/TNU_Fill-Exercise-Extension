import { describe, expect, it } from "vitest";
import { buildManualPrompt, parseManualResponse } from "../src/manual-ai";
import { migrateSettings } from "../src/storage";
import type { QuestionSnapshot } from "../src/types";

const question: QuestionSnapshot = { id: "q1", number: "1", type: "single", prompt: "2+2?", images: [], options: [{ id: "option_0", label: "3", selected: false }, { id: "option_1", label: "4", selected: false }] };
const good = { requestId: "req1", questionId: "q1", selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false };

describe("manual AI", () => {
  it("keeps the question and options even with an empty custom instruction", () => {
    const prompt = buildManualPrompt("", question, [], "req1");
    expect(prompt).toContain("2+2?");
    expect(prompt).toContain("option_1: 4");
    expect(prompt).toContain("questionId");
  });
  it("expands supported variables and includes explicit cache evidence", () => {
    const prompt = buildManualPrompt("Kiểm tra {question} với {answer_cache}", question, [], "req1", ["Kho 1: 4"]);
    expect(prompt).toContain("Kiểm tra 2+2? với Kho 1: 4");
    expect(prompt).toContain("có thể mâu thuẫn");
  });
  it("rejects unknown template variables", () => {
    expect(() => buildManualPrompt("{unknwn}", question, [], "req1")).toThrow("không được hỗ trợ");
  });
  it("accepts a complete fenced response and flags low confidence", () => {
    expect(parseManualResponse(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, question, 0.95, "req1")).toMatchObject({ selectedOptionIds: ["option_1"], needsHumanReview: true, source: "manual" });
  });
  it.each([
    "not json", "{}", JSON.stringify({ ...good, requestId: "old" }), JSON.stringify({ ...good, questionId: "old" }),
    JSON.stringify({ ...good, selectedOptionIds: ["option_3"] }),
    JSON.stringify({ ...good, selectedOptionIds: ["option_1", "option_1"] }),
    JSON.stringify({ ...good, selectedOptionIds: ["option_0", "option_1"] }),
    JSON.stringify({ ...good, confidence: "0.9" })
  ])("rejects malformed, stale or unsafe output", (value) => {
    expect(() => parseManualResponse(value, question, 0.72, "req1")).toThrow();
  });
  it("preserves old settings and chooses the existing API by default", () => {
    expect(migrateSettings({ schemaVersion: 3, model: "old-model" })).toMatchObject({ schemaVersion: 12, provider: "gemini_api", model: "old-model", webTimeoutMs: 300_000, scormPlaybackRate: 8, practiceFullScoreEnabled: false, practiceAutoSubmit: false, practiceCollectCacheWhenFull: false });
  });
});
