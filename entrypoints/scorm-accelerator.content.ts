import { applyScormRate, findScormNextButton, hasBlockingScormInteraction, normalizeScormSettings, type ScormSettings } from "../src/scorm-accelerator";
import type { AppState, RuntimeMessage, RuntimeResponse, ScormStatus } from "../src/types";

let settings: ScormSettings = { scormEnabled: false, scormPlaybackRate: 8, scormAutoNext: true, scormNextDelayMs: 750, scormPauseOnInteraction: true };
let activeMedia: HTMLMediaElement | undefined;
let mediaGeneration = 0;
let nextTimer: number | undefined;
let lastReportAt = 0;
const bound = new WeakSet<HTMLMediaElement>();
const CLOCK_EVENT = "tnu-scorm-clock-settings";
const CLOCK_RATE_ATTRIBUTE = "data-tnu-scorm-clock-rate";

function applyPlayerClock(): void {
  const rate = settings.scormEnabled ? settings.scormPlaybackRate : 1;
  document.documentElement?.setAttribute(CLOCK_RATE_ATTRIBUTE, String(rate));
  document.dispatchEvent(new Event(CLOCK_EVENT));
}

async function runtime<T = unknown>(message: RuntimeMessage): Promise<RuntimeResponse<T>> {
  return browser.runtime.sendMessage(message) as Promise<RuntimeResponse<T>>;
}

function status(state: ScormStatus["state"], message: string, media = activeMedia): void {
  const now = Date.now();
  if (state === "playing" && now - lastReportAt < 500) return;
  lastReportAt = now;
  void runtime({
    type: "SCORM_STATUS_UPDATE",
    status: {
      frameUrl: location.href,
      detected: true,
      enabled: settings.scormEnabled,
      state,
      playbackRate: media?.playbackRate ?? settings.scormPlaybackRate,
      mediaKind: media ? (media instanceof HTMLVideoElement ? "video" : "audio") : undefined,
      currentTime: media && Number.isFinite(media.currentTime) ? media.currentTime : undefined,
      duration: media && Number.isFinite(media.duration) ? media.duration : undefined,
      message,
      updatedAt: new Date().toISOString()
    }
  }).catch(() => undefined);
}

function cancelNext(): void {
  if (nextTimer !== undefined) window.clearTimeout(nextTimer);
  nextTimer = undefined;
}

function applyAll(): void {
  applyPlayerClock();
  document.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => {
    bind(media);
    if (settings.scormEnabled) applyScormRate(media, settings.scormPlaybackRate);
    else if (media.playbackRate !== 1 || media.defaultPlaybackRate !== 1) applyScormRate(media, 1);
  });
  if (!settings.scormEnabled) {
    cancelNext();
    status("idle", "Tăng tốc đang tắt.");
  } else if (!document.querySelector("audio, video")) status("waiting", "Chưa tìm thấy audio/video trong slide hiện tại.");
}

function scheduleNext(media: HTMLMediaElement, generation: number): void {
  cancelNext();
  if (!settings.scormEnabled || !settings.scormAutoNext || media.loop) return;
  if (settings.scormPauseOnInteraction && hasBlockingScormInteraction(document)) {
    status("interaction", "Slide có nội dung tương tác; hãy xử lý rồi tiếp tục.", media);
    return;
  }
  const delaySeconds = settings.scormNextDelayMs / 1000;
  status("waiting_next", `Media đã kết thúc. Chờ ${delaySeconds.toFixed(delaySeconds % 1 ? 2 : 0).replace(/\.?0+$/, "")} giây trước khi chuyển slide.`, media);
  nextTimer = window.setTimeout(() => {
    nextTimer = undefined;
    if (!settings.scormEnabled || !settings.scormAutoNext || activeMedia !== media || generation !== mediaGeneration) return;
    const next = findScormNextButton(document);
    if (!next) {
      status("completed", "Không còn nút TIẾP khả dụng; có thể đã tới slide cuối.", media);
      return;
    }
    mediaGeneration += 1;
    activeMedia = undefined;
    next.click();
    status("waiting", "Đã chuyển slide; đang chờ media tiếp theo.");
  }, settings.scormNextDelayMs);
}

function bind(media: HTMLMediaElement): void {
  if (bound.has(media)) return;
  bound.add(media);
  media.addEventListener("play", () => {
    activeMedia = media;
    mediaGeneration += 1;
    cancelNext();
    if (settings.scormEnabled) applyScormRate(media, settings.scormPlaybackRate);
    status("playing", settings.scormEnabled ? `Âm thanh và timeline đang chạy ở ${settings.scormPlaybackRate}×.` : "Đang phát ở tốc độ gốc.", media);
  });
  media.addEventListener("playing", () => {
    activeMedia = media;
    if (settings.scormEnabled) applyScormRate(media, settings.scormPlaybackRate);
    status("playing", `Âm thanh và timeline đang chạy ở ${media.playbackRate}×.`, media);
  });
  media.addEventListener("timeupdate", () => { if (activeMedia === media) status("playing", `Âm thanh và timeline đang chạy ở ${media.playbackRate}×.`, media); });
  media.addEventListener("ratechange", () => {
    if (settings.scormEnabled && media.playbackRate !== settings.scormPlaybackRate) queueMicrotask(() => applyScormRate(media, settings.scormPlaybackRate));
  });
  media.addEventListener("pause", () => { if (activeMedia === media && !media.ended) status("paused", "Media đang tạm dừng.", media); });
  media.addEventListener("waiting", () => { if (activeMedia === media) status("waiting", "Media đang chờ tải dữ liệu.", media); });
  media.addEventListener("error", () => { if (activeMedia === media) { cancelNext(); status("error", "Media gặp lỗi; không tự chuyển slide.", media); } });
  media.addEventListener("ended", () => { if (activeMedia === media) scheduleNext(media, mediaGeneration); });
}

function updateSettings(next: ScormSettings): void {
  settings = normalizeScormSettings(next);
  applyAll();
  if (settings.scormEnabled && activeMedia && !activeMedia.paused) status("playing", `Đã áp dụng ${settings.scormPlaybackRate}×.`, activeMedia);
}

export default defineContentScript({
  matches: [
    "https://tnu.aum.edu.vn/mod/scorm/loadSCO.php*",
    "https://tnu.aum.edu.vn/pluginfile.php/*/mod_scorm/content/*"
  ],
  allFrames: true,
  runAt: "document_start",
  main() {
    const observer = new MutationObserver(() => applyAll());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
      if (message.type !== "SCORM_APPLY_SETTINGS") return false;
      updateSettings(message.settings);
      sendResponse({ ok: true });
      return false;
    });
    void runtime<AppState>({ type: "GET_STATE" }).then((response) => {
      if (!response.ok || !response.data) return;
      const value = response.data.settings;
      updateSettings(value);
    });
  }
});
