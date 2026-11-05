import type { AppSettings } from "./types";

export type ScormSettings = Pick<AppSettings, "scormEnabled" | "scormPlaybackRate" | "scormAutoNext" | "scormNextDelayMs" | "scormPauseOnInteraction">;

export const SCORM_RATES = [1, 1.5, 2, 3, 4, 6, 8] as const;

export function normalizeScormSettings(value: ScormSettings): ScormSettings {
  return {
    scormEnabled: value.scormEnabled === true,
    scormPlaybackRate: SCORM_RATES.includes(value.scormPlaybackRate as (typeof SCORM_RATES)[number]) ? value.scormPlaybackRate : 1,
    scormAutoNext: value.scormAutoNext !== false,
    scormNextDelayMs: Number.isFinite(value.scormNextDelayMs) ? Math.max(0, Math.min(10_000, value.scormNextDelayMs)) : 750,
    scormPauseOnInteraction: value.scormPauseOnInteraction !== false
  };
}

export function applyScormRate(media: HTMLMediaElement, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
  if ("preservesPitch" in media) media.preservesPitch = true;
}

function usable(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

export function findScormNextButton(document: Document): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>('button, input[type="button"], input[type="submit"], [role="button"]')];
  return candidates.find((element) => {
    if (!usable(element) || ("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) || element.getAttribute("aria-disabled") === "true") return false;
    const text = `${element.textContent ?? ""} ${(element as HTMLInputElement).value ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${element.id}`.replace(/\s+/g, " ").trim().toLowerCase();
    return /(^|\s)(tiếp|next)(\s|$)/i.test(text) || /next[-_ ]?slide/i.test(text);
  });
}

export function hasBlockingScormInteraction(document: Document): boolean {
  const scope = document.querySelector<HTMLElement>("#playerView") ?? document.body;
  const controls = [...scope.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, button, [role="radio"], [role="checkbox"]')];
  return controls.some((element) => {
    if (!usable(element) || ("disabled" in element && Boolean((element as HTMLInputElement).disabled))) return false;
    const identity = `${element.id} ${element.className} ${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`.toLowerCase();
    return !/(next|previous|prev|tiếp|trước|pause|play|replay|fullscreen|volume|mute)/i.test(identity);
  });
}
