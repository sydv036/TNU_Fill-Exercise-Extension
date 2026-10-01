import type { AppSettings } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 2,
  model: "",
  customModel: "",
  uncertainMode: "reason",
  confidenceThreshold: 0.72,
  timeoutMs: 30_000,
  retryCount: 2,
  delayMs: 450,
  practiceKeywords: ["luyện tập", "ôn tập", "không tính điểm"],
  gradedKeywords: ["kiểm tra", "thi"],
  notificationsEnabled: true,
  soundEnabled: true,
  volume: 0.65,
  autoNavigate: true,
  showReason: true
};
