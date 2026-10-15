import { describe, expect, it } from "vitest";
import { chunkText, searchKnowledge, searchSelectedKnowledge } from "../src/knowledge";
import type { KnowledgeChunk } from "../src/types";

const chunks: KnowledgeChunk[] = [
  { id: "johari", courseId: "1", materialId: "m1", materialName: "Giáo trình Bài 1", materialUrl: "https://example.test/1", week: "Tuần 1", kind: "textbook", page: 4, text: "Cửa sổ Johari gồm phần công khai, phần mù, phần ẩn và phần chưa biết." },
  { id: "smart", courseId: "1", materialId: "m2", materialName: "Slide Bài 3", materialUrl: "https://example.test/2", week: "Tuần 3", kind: "slide", page: 8, text: "Mục tiêu SMART cần cụ thể, đo lường được và có thời hạn." }
];

describe("Course knowledge search", () => {
  it("matches Vietnamese queries without depending on accents", () => {
    expect(searchKnowledge(chunks, "mo hinh cua so Johari")[0]?.id).toBe("johari");
  });

  it("ranks material title and content matches", () => {
    expect(searchKnowledge(chunks, "mục tiêu SMART")[0]?.id).toBe("smart");
  });

  it("splits long document text into overlapping chunks", () => {
    const result = chunkText("Nội dung bài học. ".repeat(500), 500);
    expect(result.length).toBeGreaterThan(5);
    expect(result.every((item) => item.length <= 500)).toBe(true);
  });

  it("searches only the materials explicitly attached to the run", () => {
    expect(searchSelectedKnowledge(chunks, ["m1"], "mục tiêu SMART", 8)).toEqual([]);
    expect(searchSelectedKnowledge(chunks, ["m2"], "mục tiêu SMART", 8).map((chunk) => chunk.id)).toEqual(["smart"]);
  });

  it("does not provide knowledge when no material is attached", () => {
    expect(searchSelectedKnowledge(chunks, [], "Johari", 8)).toEqual([]);
  });
});
