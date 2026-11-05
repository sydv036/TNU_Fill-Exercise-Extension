const CLOCK_EVENT = "tnu-scorm-clock-settings";
const CLOCK_RATE_ATTRIBUTE = "data-tnu-scorm-clock-rate";
const CLOCK_APPLIED_ATTRIBUTE = "data-tnu-scorm-clock-applied";

type TimerHandler = string | ((...args: unknown[]) => void);

export default defineContentScript({
  matches: [
    "https://tnu.aum.edu.vn/mod/scorm/loadSCO.php*",
    "https://tnu.aum.edu.vn/pluginfile.php/*/mod_scorm/content/*"
  ],
  allFrames: true,
  runAt: "document_start",
  world: "MAIN",
  main() {
    const marker = "__tnuScormClockV1__";
    const page = window as Window & typeof globalThis & Record<string, unknown>;
    if (page[marker]) return;
    page[marker] = true;

    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const nativeRequestAnimationFrame = window.requestAnimationFrame?.bind(window);
    const nativeCancelAnimationFrame = window.cancelAnimationFrame?.bind(window);
    const nativePerformanceNow = window.performance?.now?.bind(window.performance);
    const NativeDate = window.Date;
    let rate = 1;
    let realAnchor = nativePerformanceNow?.() ?? 0;
    let virtualAnchor = realAnchor;
    let realEpochAnchor = NativeDate.now();
    let virtualEpochAnchor = realEpochAnchor;
    let nextIntervalId = -1;

    const virtualNow = (real = nativePerformanceNow?.() ?? 0) => virtualAnchor + ((real - realAnchor) * rate);
    const virtualEpochNow = (real = NativeDate.now()) => virtualEpochAnchor + ((real - realEpochAnchor) * rate);
    const scaledDelay = (delay?: number) => Number.isFinite(delay) ? Math.max(0, Number(delay) / rate) : 0;
    const intervals = new Map<number, { handler: TimerHandler; delay: number; args: unknown[]; nativeId?: number }>();

    const invoke = (handler: TimerHandler, args: unknown[]) => {
      if (typeof handler === "function") handler(...args);
      else (0, eval)(handler);
    };

    const scheduleInterval = (id: number) => {
      const entry = intervals.get(id);
      if (!entry) return;
      entry.nativeId = nativeSetTimeout(() => {
        if (!intervals.has(id)) return;
        try { invoke(entry.handler, entry.args); }
        finally { if (intervals.has(id)) scheduleInterval(id); }
      }, scaledDelay(entry.delay));
    };

    const clearAcceleratedInterval = (id?: number) => {
      if (typeof id !== "number") return false;
      const entry = intervals.get(id);
      if (!entry) return false;
      if (entry.nativeId !== undefined) nativeClearTimeout(entry.nativeId);
      intervals.delete(id);
      return true;
    };

    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => nativeSetTimeout(handler as TimerHandler, scaledDelay(delay), ...args)) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (!clearAcceleratedInterval(id)) nativeClearTimeout(id); }) as typeof window.clearTimeout;
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const id = nextIntervalId--;
      intervals.set(id, { handler, delay: Number.isFinite(delay) ? Math.max(0, Number(delay)) : 0, args });
      scheduleInterval(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => {
      if (!clearAcceleratedInterval(id)) nativeClearInterval(id);
    }) as typeof window.clearInterval;

    if (nativeRequestAnimationFrame) {
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => nativeRequestAnimationFrame((timestamp) => callback(virtualNow(timestamp)))) as typeof window.requestAnimationFrame;
    }
    if (nativeCancelAnimationFrame) window.cancelAnimationFrame = ((id: number) => nativeCancelAnimationFrame(id)) as typeof window.cancelAnimationFrame;
    try { Object.defineProperty(window.performance, "now", { configurable: true, value: () => virtualNow() }); }
    catch { /* Old Chromium may keep performance.now non-configurable; rAF/timers still accelerate. */ }
    try {
      const AcceleratedDate = function(this: Date, ...args: unknown[]) {
        if (!new.target) return new NativeDate(virtualEpochNow()).toString();
        return Reflect.construct(NativeDate, args.length ? args : [virtualEpochNow()], new.target);
      } as unknown as DateConstructor;
      Object.setPrototypeOf(AcceleratedDate, NativeDate);
      Object.defineProperty(AcceleratedDate, "prototype", { value: NativeDate.prototype });
      AcceleratedDate.now = () => virtualEpochNow();
      window.Date = AcceleratedDate;
    } catch { /* Timers and performance.now remain accelerated if Date cannot be wrapped. */ }

    const applyRate = () => {
      const raw = document.documentElement?.getAttribute(CLOCK_RATE_ATTRIBUTE);
      const next = Number(raw);
      const safe = Number.isFinite(next) && next > 0 && next <= 16 ? next : 1;
      const now = nativePerformanceNow?.() ?? 0;
      const epochNow = NativeDate.now();
      virtualAnchor = virtualNow(now);
      virtualEpochAnchor = virtualEpochNow(epochNow);
      realAnchor = now;
      realEpochAnchor = epochNow;
      rate = safe;
      for (const entry of intervals.values()) if (entry.nativeId !== undefined) nativeClearTimeout(entry.nativeId);
      for (const id of intervals.keys()) scheduleInterval(id);
      document.documentElement?.setAttribute(CLOCK_APPLIED_ATTRIBUTE, String(rate));
    };

    document.addEventListener(CLOCK_EVENT, applyRate);
    if (document.documentElement) applyRate();
    else document.addEventListener("readystatechange", applyRate, { once: true });
  }
});
