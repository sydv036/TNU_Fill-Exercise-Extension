import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginCheckpoint, clearCheckpoint, getCheckpoint, stopCheckpoint, updateCheckpoint } from "../src/request-checkpoint";

let data: Record<string, unknown>;
beforeEach(() => {
  data = {};
  vi.stubGlobal("browser", { storage: { local: {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(data, value); },
    remove: async (key: string) => { delete data[key]; }
  } } });
});

describe("request checkpoints", () => {
  it("persists the request and rejects stale updates", async () => {
    const request = await beginCheckpoint("run", "q1", { executionEpoch: "e1", providerId: "gemini_api", modelId: "gemini-a" });
    await expect(updateCheckpoint(request.requestId, "completed")).rejects.toThrow();
    await updateCheckpoint(request.requestId, "sending");
    await updateCheckpoint(request.requestId, "waiting");
    expect(await getCheckpoint()).toMatchObject({ runId: "run", questionId: "q1", phase: "waiting", executionEpoch: "e1", providerId: "gemini_api", modelId: "gemini-a" });
    await expect(updateCheckpoint("old", "completed")).rejects.toThrow();
    await expect(beginCheckpoint("run", "q2")).rejects.toThrow();
  });
  it("serializes simultaneous starts and blocks ambiguous delivery even in a new run", async () => {
    const results = await Promise.allSettled([beginCheckpoint("r", "q"), beginCheckpoint("r", "q")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const checkpoint = await getCheckpoint();
    await updateCheckpoint(checkpoint!.requestId, "unknown_delivery");
    await expect(beginCheckpoint("new-run", "q")).rejects.toThrow();
    await clearCheckpoint();
    await expect(beginCheckpoint("new-run", "q")).resolves.toMatchObject({ phase: "prepared" });
  });
  it("blocks replay of a completed question but allows the next one", async () => {
    const checkpoint = await beginCheckpoint("r", "q1");
    await updateCheckpoint(checkpoint.requestId, "sending");
    await updateCheckpoint(checkpoint.requestId, "waiting");
    await updateCheckpoint(checkpoint.requestId, "completed");
    await expect(beginCheckpoint("r", "q1")).rejects.toThrow();
    await expect(beginCheckpoint("r", "q2")).resolves.toMatchObject({ questionId: "q2" });
  });
  it("persists the release lifecycle and permits a distinct reasoning attempt after completion", async () => {
    const first = await beginCheckpoint("r", "q1", { requestId: "attempt-1", providerId: "openai_api", modelId: "model-a" });
    await updateCheckpoint(first.requestId, "reserved", { reservationId: "budget-1" });
    await updateCheckpoint(first.requestId, "dispatching");
    await updateCheckpoint(first.requestId, "in_flight");
    expect(await getCheckpoint()).toMatchObject({ phase: "in_flight", reservationId: "budget-1" });
    await updateCheckpoint(first.requestId, "completed");
    expect(await getCheckpoint()).toMatchObject({ phase: "completed" });
    const reasoning = await beginCheckpoint("r", "q1", { requestId: "attempt-2", providerId: "openai_api", modelId: "model-a" });
    expect(reasoning).toMatchObject({ phase: "prepared", requestId: "attempt-2", questionId: "q1" });
  });
  it("allows only confirmed not-sent transitions to reject a request and retains uncertain delivery", async () => {
    const beforeDispatch = await beginCheckpoint("r", "q1");
    await updateCheckpoint(beforeDispatch.requestId, "reserved", { reservationId: "budget-1" });
    await updateCheckpoint(beforeDispatch.requestId, "rejected");
    expect(await getCheckpoint()).toMatchObject({ phase: "rejected" });
    await clearCheckpoint();

    const dispatched = await beginCheckpoint("r", "q2");
    await updateCheckpoint(dispatched.requestId, "reserved", { reservationId: "budget-2" });
    await updateCheckpoint(dispatched.requestId, "dispatching");
    await updateCheckpoint(dispatched.requestId, "in_flight");
    await updateCheckpoint(dispatched.requestId, "unknown_delivery");
    await expect(updateCheckpoint(dispatched.requestId, "rejected")).rejects.toThrow();
    await updateCheckpoint(dispatched.requestId, "completed");
    expect(await getCheckpoint()).toMatchObject({ phase: "completed" });
  });
  it("clears unsent work and marks a sent request as unknown when stopped", async () => {
    await beginCheckpoint("r", "q1");
    await stopCheckpoint("r");
    expect(await getCheckpoint()).toBeUndefined();
    const next = await beginCheckpoint("r", "q1");
    await updateCheckpoint(next.requestId, "sending");
    await stopCheckpoint("r");
    expect(await getCheckpoint()).toMatchObject({ phase: "unknown_delivery" });
  });
});
