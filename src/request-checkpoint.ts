export type RequestPhase = "prepared" | "reserved" | "dispatching" | "in_flight" | "rejected" | "sending" | "waiting" | "completed" | "unknown_delivery";
export interface RequestCheckpoint { runId: string; questionId: string; requestId: string; phase: RequestPhase; reservationId?: string; executionEpoch?: string; providerId?: string; modelId?: string; }

const KEY = "answerRequestCheckpointV1";
let serial: Promise<unknown> = Promise.resolve();
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = serial.then(operation, operation);
  serial = next.catch(() => undefined);
  return next;
}

export async function getCheckpoint(): Promise<RequestCheckpoint | undefined> {
  const value = await browser.storage.local.get(KEY);
  return value[KEY] as RequestCheckpoint | undefined;
}

export function beginCheckpoint(runId: string, questionId: string, identity?: Pick<RequestCheckpoint, "executionEpoch" | "providerId" | "modelId"> & { requestId?: string }): Promise<RequestCheckpoint> {
  return exclusive(async () => {
    const previous = await getCheckpoint();
    if (previous && (previous.phase !== "completed" || (previous.runId === runId && previous.questionId === questionId && (!identity?.requestId || previous.requestId === identity.requestId)))) {
      throw new Error("Yêu cầu trước chưa được đối soát. Hãy kiểm tra và xác nhận xử lý yêu cầu cũ trước khi thử lại.");
    }
    const checkpoint: RequestCheckpoint = { runId, questionId, requestId: identity?.requestId ?? crypto.randomUUID(), phase: "prepared", ...identity };
    await browser.storage.local.set({ [KEY]: checkpoint });
    return checkpoint;
  });
}

export function updateCheckpoint(requestId: string, phase: RequestPhase, patch: Pick<RequestCheckpoint, "reservationId"> = {}): Promise<void> {
  return exclusive(async () => {
    const current = await getCheckpoint();
    if (!current || current.requestId !== requestId) throw new Error("Yêu cầu đã thay đổi; từ chối cập nhật trạng thái cũ.");
    const transitions: Record<RequestPhase, RequestPhase[]> = {
      prepared: ["reserved", "rejected", "unknown_delivery", "sending"],
      reserved: ["dispatching", "rejected", "unknown_delivery"],
      dispatching: ["in_flight", "rejected", "unknown_delivery"],
      in_flight: ["completed", "rejected", "unknown_delivery"],
      rejected: ["reserved", "completed", "unknown_delivery"],
      sending: ["waiting", "unknown_delivery", "rejected"],
      waiting: ["completed", "unknown_delivery", "rejected"],
      completed: [], unknown_delivery: ["completed"]
    };
    if (!transitions[current.phase]?.includes(phase)) throw new Error("Chuyển trạng thái yêu cầu không hợp lệ.");
    await browser.storage.local.set({ [KEY]: { ...current, ...patch, phase } });
  });
}

export function clearCheckpoint(): Promise<void> {
  return exclusive(async () => { await browser.storage.local.remove(KEY); });
}

// Called only when the adapter can prove no attempted request is still in flight.
export function clearRejectedCheckpoint(requestId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getCheckpoint();
    if (current?.requestId === requestId && ["prepared", "reserved", "rejected", "sending", "waiting"].includes(current.phase)) await browser.storage.local.remove(KEY);
  });
}

export function retargetRejectedCheckpoint(requestId: string, providerId: string, modelId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getCheckpoint();
    if (!current || current.requestId !== requestId || current.phase !== "rejected") throw new Error("Checkpoint không còn hiệu lực để chuyển provider.");
    await browser.storage.local.set({ [KEY]: { ...current, providerId, modelId, reservationId: undefined } });
  });
}

export function stopCheckpoint(runId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getCheckpoint();
    if (!current || current.runId !== runId) return;
    if (["prepared", "reserved", "rejected"].includes(current.phase)) await browser.storage.local.remove(KEY);
    else if (["dispatching", "in_flight", "sending", "waiting"].includes(current.phase)) await browser.storage.local.set({ [KEY]: { ...current, phase: "unknown_delivery" } });
  });
}

export function clearCompletedCheckpoint(runId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getCheckpoint();
    if (current?.runId === runId && current.phase === "completed") await browser.storage.local.remove(KEY);
  });
}
