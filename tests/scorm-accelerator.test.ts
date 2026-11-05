import { describe, expect, it } from "vitest";
import { applyScormRate, findScormNextButton, hasBlockingScormInteraction, normalizeScormSettings } from "../src/scorm-accelerator";

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("SCORM accelerator", () => {
  it("supports the selected 8x rate and clamps unsafe delay values", () => {
    expect(normalizeScormSettings({ scormEnabled: true, scormPlaybackRate: 8, scormAutoNext: true, scormNextDelayMs: 99_000, scormPauseOnInteraction: true })).toMatchObject({ scormPlaybackRate: 8, scormNextDelayMs: 10_000 });
    expect(normalizeScormSettings({ scormEnabled: true, scormPlaybackRate: 7, scormAutoNext: true, scormNextDelayMs: -1, scormPauseOnInteraction: true })).toMatchObject({ scormPlaybackRate: 1, scormNextDelayMs: 0 });
  });

  it("applies both current and default playback rate without seeking", () => {
    const audio = doc("<audio></audio>").querySelector("audio")!;
    const before = audio.currentTime;
    applyScormRate(audio, 8);
    expect(audio.playbackRate).toBe(8);
    expect(audio.defaultPlaybackRate).toBe(8);
    expect(audio.currentTime).toBe(before);
  });

  it("finds the real enabled next-slide control and ignores disabled controls", () => {
    const document = doc('<button disabled>TIẾP</button><button aria-label="next slide">TIẾP</button>');
    expect(findScormNextButton(document)?.getAttribute("aria-label")).toBe("next slide");
  });

  it("pauses for real slide interactions but ignores player controls", () => {
    expect(hasBlockingScormInteraction(doc('<div id="playerView"><button aria-label="pause"></button></div>'))).toBe(false);
    expect(hasBlockingScormInteraction(doc('<div id="playerView"><input type="radio" name="answer"></div>'))).toBe(true);
  });
});
