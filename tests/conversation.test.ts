import { describe, expect, it } from "vitest";
import { recordManualReply, shouldStartManualChat } from "../src/conversation";

describe("manual conversation rotation", () => {
  it("rotates at the configured count and honors disabled rotation", () => {
    expect(shouldStartManualChat(9, 10, false)).toBe(false);
    expect(shouldStartManualChat(10, 10, false)).toBe(true);
    expect(shouldStartManualChat(100, 0, false)).toBe(false);
    expect(shouldStartManualChat(0, 0, true)).toBe(true);
  });
  it("records a validated reply once in the current or newly confirmed chat", () => {
    expect(recordManualReply(9, false)).toBe(10);
    expect(recordManualReply(10, true)).toBe(1);
  });
});
