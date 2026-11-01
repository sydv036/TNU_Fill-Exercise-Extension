import type { QuestionSnapshot } from "./types";

// Fixed, synthetic 32×32 red PNG; no user data is included in capability probes.
const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
export function capabilityQuestion(image: boolean): QuestionSnapshot {
  return {
    id: "capability-probe", number: "Kiểm tra mẫu", type: "single",
    prompt: image ? "Ảnh đính kèm có màu gì?" : "2 + 2 bằng bao nhiêu?",
    images: image ? [{ mimeType: "image/png", data: RED_PNG }] : [],
    options: [
      { id: "option_0", label: image ? "Màu xanh" : "3", selected: false },
      { id: "option_1", label: image ? "Màu đỏ" : "4", selected: false }
    ]
  };
}
