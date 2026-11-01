import { describe, expect, it } from "vitest";
import { buildManualPrompt, parseManualResponse } from "../src/manual-ai";
import { applyVerifiedDecisionToElement, extractQuestion } from "../src/moodle";

function fixture() {
  const document = new DOMParser().parseFromString('<div class="que" id="question-9"><div class="qtext">2 + 2?</div><div class="answer"><label><input type="radio" name="q">3</label><label><input type="radio" name="q">4</label></div></div>', "text/html");
  return document.querySelector<HTMLElement>(".que")!;
}

describe("manual workflow integration", () => {
  it("extracts, prepares, parses and applies a matching answer", () => {
    const element = fixture();
    const question = extractQuestion(element, 0);
    expect(buildManualPrompt("Giải", question, [], "req1")).toContain("option_1: 4");
    const response = JSON.stringify({ requestId: "req1", questionId: question.id, selectedOptionIds: ["option_1"], confidence: 0.9, reason: "2+2=4", needsHumanReview: false });
    const decision = parseManualResponse(response, question, 0.72, "req1");
    expect(applyVerifiedDecisionToElement(element, question, decision.selectedOptionIds)).toBe(true);
    expect(element.querySelectorAll<HTMLInputElement>("input")[1]!.checked).toBe(true);
  });
  it("refuses to apply a valid response if the choices have been reordered", () => {
    const element = fixture();
    const question = extractQuestion(element, 0);
    const answer = element.querySelector(".answer")!;
    answer.prepend(answer.lastElementChild!);
    const response = JSON.stringify({ requestId: "req1", questionId: question.id, selectedOptionIds: ["option_1"], confidence: 0.9, reason: "4", needsHumanReview: false });
    const decision = parseManualResponse(response, question, 0.72, "req1");
    expect(applyVerifiedDecisionToElement(element, question, decision.selectedOptionIds)).toBe(false);
    expect([...element.querySelectorAll<HTMLInputElement>("input")].some((input) => input.checked)).toBe(false);
  });
});
