import { describe, expect, it } from "vitest";
import { getProvider, PROVIDERS } from "../src/providers";

describe("provider registry", () => {
  it("reports API and manual capabilities accurately", () => {
    expect(getProvider("gemini_api").supportsAutomatedRequests).toBe(true);
    expect(getProvider("deepseek_web")).toMatchObject({ mode: "web", supportsAutomatedRequests: true, supportsImages: true });
    for (const provider of PROVIDERS.filter((item) => item.mode === "manual")) {
      expect(provider.supportsAutomatedRequests).toBe(false);
      expect(provider.supportsVerifiedConversationReset).toBe(false);
    }
  });
  it("rejects unknown providers", () => {
    expect(() => getProvider("missing" as never)).toThrow();
  });
});
