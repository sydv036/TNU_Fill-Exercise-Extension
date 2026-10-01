import { describe, expect, it } from "vitest";
import { classifyAssessment, normalizeText } from "../src/classifier";
import { DEFAULT_SETTINGS } from "../src/defaults";

describe("classifyAssessment", () => {
  it("normalizes Vietnamese accents", () => {
    expect(normalizeText("  BÀI LUYỆN   TẬP  ")).toBe("bai luyen tap");
  });

  it("classifies practice and graded names", () => {
    expect(classifyAssessment("Tuần 1 - Bài luyện tập 1", DEFAULT_SETTINGS)).toBe("practice");
    expect(classifyAssessment("Tuần 4: Ôn tập và làm Bài kiểm tra 1", DEFAULT_SETTINGS)).toBe("graded");
    expect(classifyAssessment("Khảo sát đầu kỳ", DEFAULT_SETTINGS)).toBe("unknown");
  });

  it("gives graded keywords priority", () => {
    expect(classifyAssessment("Ôn tập cho bài kiểm tra", DEFAULT_SETTINGS)).toBe("graded");
  });
});
