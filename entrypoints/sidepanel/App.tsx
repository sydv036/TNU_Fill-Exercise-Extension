import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyAssessment, normalizeText } from "../../src/classifier";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { recommendedGeminiModels } from "../../src/gemini";
import type { AppSettings, AppState, GeminiModel, QuizTarget, RunMode, RuntimeMessage, RuntimeResponse, RunStatus } from "../../src/types";

type TabId = "courses" | "queue" | "run" | "gemini" | "settings" | "logs";

const EMPTY_STATE: AppState = { settings: DEFAULT_SETTINGS, apiKeyPresent: false, queue: [], logs: [], answerMemoryCount: 0, storageBytes: 0 };
const TAB_ITEMS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: "courses", label: "Khóa học", icon: "▦" },
  { id: "queue", label: "Hàng đợi", icon: "≡" },
  { id: "run", label: "Đang chạy", icon: "▶" },
  { id: "gemini", label: "Gemini", icon: "✦" },
  { id: "settings", label: "Cài đặt", icon: "⚙" },
  { id: "logs", label: "Nhật ký", icon: "◷" }
];

async function runtime<T = unknown>(message: RuntimeMessage): Promise<T> {
  const response = await browser.runtime.sendMessage(message) as RuntimeResponse<T>;
  if (!response.ok) throw new Error(response.error || "Thao tác thất bại.");
  return response.data as T;
}

function statusLabel(status?: RunStatus): string {
  return ({ idle: "Sẵn sàng", scanning: "Đang quét", preparing: "Chuẩn bị", answering: "Đang trả lời", awaiting_user: "Chờ bạn", navigating: "Chuyển trang", paused: "Đã dừng", completed: "Hoàn tất", error: "Có lỗi" } as Record<string, string>)[status || "idle"] ?? "Sẵn sàng";
}

function kindLabel(kind: QuizTarget["assessmentKind"]): string {
  return kind === "practice" ? "Luyện tập" : kind === "graded" ? "Kiểm tra" : "Chưa xác định";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function beep(volume: number, status: RunStatus): void {
  const context = new AudioContext();
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  oscillator.type = status === "completed" ? "sine" : "triangle";
  oscillator.frequency.value = status === "completed" ? 880 : status === "error" ? 220 : 520;
  gain.gain.setValueAtTime(Math.max(0.01, volume * 0.16), context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.28);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(); oscillator.stop(context.currentTime + 0.3);
  oscillator.addEventListener("ended", () => void context.close());
}

export default function App() {
  const [tab, setTab] = useState<TabId>("courses");
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const previousStatus = useRef<RunStatus | undefined>(undefined);

  const refresh = useCallback(async () => {
    try { setState(await runtime<AppState>({ type: "GET_STATE" })); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => {
    void refresh();
    const listener = () => void refresh();
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [refresh]);

  useEffect(() => {
    const status = state.run?.status;
    if (status && status !== previousStatus.current && state.settings.soundEnabled && ["awaiting_user", "completed", "error"].includes(status)) {
      beep(state.settings.volume, status);
    }
    previousStatus.current = status;
  }, [state.run?.status, state.settings.soundEnabled, state.settings.volume]);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true); setNotice("");
    try { await fn(); if (success) setNotice(success); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <div className="shell">
    <header className="topbar">
      <div className="brandmark">T</div>
      <div><h1>TNU Gemini</h1><p>Study Assistant</p></div>
      <span className={`status status-${state.run?.status || "idle"}`}>{statusLabel(state.run?.status)}</span>
    </header>
    <nav className="tabs" aria-label="Điều hướng extension">
      {TAB_ITEMS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} title={item.label}><span>{item.icon}</span><small>{item.label}</small></button>)}
    </nav>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
    <main>
      {tab === "courses" && <Courses state={state} busy={busy} act={act} setTab={setTab} />}
      {tab === "queue" && <Queue state={state} busy={busy} act={act} setTab={setTab} />}
      {tab === "run" && <RunPanel state={state} busy={busy} act={act} />}
      {tab === "gemini" && <GeminiPanel state={state} busy={busy} act={act} />}
      {tab === "settings" && <SettingsPanel state={state} busy={busy} act={act} />}
      {tab === "logs" && <Logs state={state} />}
    </main>
  </div>;
}

function Courses({ state, busy, act, setTab }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; setTab: (tab: TabId) => void }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const add = (target: QuizTarget) => act(() => runtime({ type: "SAVE_QUEUE", queue: [...state.queue.filter((item) => item.id !== target.id), target] }), "Đã thêm vào hàng đợi.");
  return <section>
    <div className="section-head"><div><h2>Khóa học của tôi</h2><p>{state.courseIndex ? `Cập nhật ${new Date(state.courseIndex.scannedAt).toLocaleString("vi-VN")}` : "Chưa quét dữ liệu"}</p></div><button className="primary compact" disabled={busy} onClick={() => act(() => runtime({ type: "SCAN_COURSES" }), "Quét khóa học hoàn tất.")}>{busy ? "Đang quét…" : "Quét lại"}</button></div>
    {!state.courseIndex?.courses.length && <Empty icon="▦" title="Chưa có khóa học" text="Mở trang TNU rồi bấm Quét lại để lấy danh sách ngành, khóa học và bài quiz." />}
    <div className="course-list">
      {state.courseIndex?.courses.map((course) => <article className="course-card" key={course.id}>
        <button className="course-title" onClick={() => setExpanded((items) => items.includes(course.id) ? items.filter((id) => id !== course.id) : [...items, course.id])}>
          <span className="course-icon">▤</span><span><b>{course.name}</b><small>{course.category} · {course.weeks.reduce((sum, week) => sum + week.activities.length, 0)} bài</small></span><i>{expanded.includes(course.id) ? "⌃" : "⌄"}</i>
        </button>
        {expanded.includes(course.id) && <div className="weeks">{course.weeks.map((week) => <div key={week.id}><h3>{week.name}</h3>{week.activities.map((activity) => <div className="activity" key={activity.id}><span><b>{activity.name}</b><small className={`pill ${activity.assessmentKind}`}>{kindLabel(activity.assessmentKind)}</small></span><button onClick={() => void add(activity)}>＋</button></div>)}</div>)}</div>}
      </article>)}
    </div>
    <ManualTarget state={state} act={act} onAdded={() => setTab("queue")} />
  </section>;
}

function ManualTarget({ state, act, onAdded }: { state: AppState; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; onAdded: () => void }) {
  const [courseId, setCourseId] = useState("");
  const [week, setWeek] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const course = state.courseIndex?.courses.find((item) => item.id === courseId);
  const matches = useMemo(() => course?.weeks.flatMap((item) => item.activities).filter((item) => (!week || normalizeText(item.week).includes(normalizeText(week))) && (!name || normalizeText(item.name).includes(normalizeText(name)))) ?? [], [course, week, name]);
  const add = async () => {
    const matched = matches[0];
    if (!matched && (!course || !url.trim() || !name.trim())) throw new Error("Hãy chọn khóa học, nhập tên và URL hoặc chọn kết quả khớp.");
    const target: QuizTarget = matched ? { ...matched, source: "manual" } : {
      id: `manual:${crypto.randomUUID()}`, url: url.trim(), courseId: course!.id, courseName: course!.name,
      category: course!.category, week: week.trim() || "Nhập thủ công", name: name.trim(),
      assessmentKind: classifyAssessment(`${week} ${name}`, state.settings), source: "manual"
    };
    await runtime({ type: "SAVE_QUEUE", queue: [...state.queue.filter((item) => item.id !== target.id), target] });
    onAdded();
  };
  return <details className="manual-card"><summary>＋ Thêm bài thủ công</summary><div className="form-grid">
    <label>Khóa học<select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">Chọn khóa học</option>{state.courseIndex?.courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>Tuần<input value={week} onChange={(event) => setWeek(event.target.value)} placeholder="Ví dụ: Tuần 4" /></label>
    <label>Tên bài<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ví dụ: Bài kiểm tra 1" /></label>
    <label>URL dự phòng<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://tnu.aum.edu.vn/mod/quiz/..." /></label>
    {matches.length > 0 && <div className="match">Khớp gần nhất: <b>{matches[0]!.week} · {matches[0]!.name}</b></div>}
    <button className="secondary" onClick={() => void act(add, "Đã thêm bài thủ công.")}>Thêm vào hàng đợi</button>
  </div></details>;
}

function Queue({ state, busy, act, setTab }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; setTab: (tab: TabId) => void }) {
  const remove = (id: string) => act(() => runtime({ type: "SAVE_QUEUE", queue: state.queue.filter((item) => item.id !== id) }));
  const start = (target: QuizTarget, mode: RunMode) => act(async () => { await runtime({ type: "START_RUN", target, mode }); setTab("run"); });
  return <section><div className="section-head"><div><h2>Hàng đợi</h2><p>{state.queue.length} bài đã chọn</p></div></div>
    {!state.queue.length && <Empty icon="≡" title="Hàng đợi đang trống" text="Thêm bài từ danh sách khóa học hoặc form nhập thủ công." />}
    {state.queue.map((target) => <article className="queue-card" key={target.id}><div className="queue-top"><span className={`pill ${target.assessmentKind}`}>{kindLabel(target.assessmentKind)}</span><button className="icon-button danger" onClick={() => void remove(target.id)}>×</button></div><h3>{target.name}</h3><p>{target.courseName}</p><small>{target.week}</small><div className="actions"><button className="primary" disabled={busy} onClick={() => void start(target, "from_start")}>Bắt đầu</button><button className="secondary" disabled={busy} onClick={() => void start(target, "from_current")}>Từ câu hiện tại</button></div></article>)}
  </section>;
}

function RunPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const run = state.run;
  if (!run) return <section><h2>Đang chạy</h2><Empty icon="▶" title="Chưa có phiên chạy" text="Chọn một bài trong Hàng đợi để bắt đầu." /></section>;
  const progress = run.totalOnPage ? Math.round((Math.max(0, run.currentQuestion - 1) / run.totalOnPage) * 100) : 0;
  const visibleQuestion = run.pendingDecision?.question ?? run.currentQuestionSnapshot;
  const suggestedIds = new Set(run.pendingDecision?.decision.selectedOptionIds ?? []);
  return <section><div className="run-hero"><span className={`pill ${run.target.assessmentKind}`}>{kindLabel(run.target.assessmentKind)}</span><h2>{run.target.name}</h2><p>{run.target.courseName} · {run.target.week}</p></div>
    <div className="progress-card"><div className="progress-label"><span>Trang {run.page}</span><b>{run.currentQuestion}/{run.totalOnPage || "–"} câu</b></div><div className="progress"><i style={{ width: `${progress}%` }} /></div><p>{run.message}</p>{run.error && <div className="error-box">{run.error}</div>}</div>
    {visibleQuestion && <article className="question-preview"><div><span>{visibleQuestion.number}</span><small>{visibleQuestion.type === "multiple" ? "Chọn nhiều đáp án" : visibleQuestion.type === "truefalse" ? "Đúng / Sai" : visibleQuestion.type === "unsupported" ? "Cần làm thủ công" : "Chọn một đáp án"}</small></div><h3>{visibleQuestion.prompt || "Câu hỏi không có nội dung chữ"}</h3><div className="preview-options">{visibleQuestion.options.map((option) => <div key={option.id} className={suggestedIds.has(option.id) ? "suggested" : option.selected ? "selected" : ""}><i>{visibleQuestion.type === "multiple" ? "□" : "○"}</i><span>{option.label}</span>{suggestedIds.has(option.id) && <b>Gợi ý</b>}</div>)}</div></article>}
    <div className="quick-mode"><span>Khi Gemini phân vân</span><div><button className={state.settings.uncertainMode === "reason" ? "active" : ""} onClick={() => void act(() => runtime({ type: "SAVE_SETTINGS", settings: { ...state.settings, uncertainMode: "reason" } }), "Đã bật tự suy luận lại.")}>✦ Tự suy luận</button><button className={state.settings.uncertainMode === "ask" ? "active" : ""} onClick={() => void act(() => runtime({ type: "SAVE_SETTINGS", settings: { ...state.settings, uncertainMode: "ask" } }), "Đã chuyển sang hỏi bạn.")}>? Hỏi tôi</button></div></div>
    {run.pendingDecision && <article className="suggestion"><div><span>{run.pendingDecision.decision.selectedOptionIds.length ? (run.pendingDecision.decision.source === "memory" ? "Từ bộ nhớ đáp án" : run.pendingDecision.decision.reasoningPass ? "Gemini đã suy luận lại" : "Gợi ý Gemini") : "Cần bạn xử lý"}</span><b>{Math.round(run.pendingDecision.decision.confidence * 100)}%</b></div><h3>{run.pendingDecision.question.number}</h3>{run.pendingDecision.decision.selectedOptionIds.length > 0 && <p>{run.pendingDecision.decision.selectedOptionIds.map((id) => run.pendingDecision!.question.options.find((option) => option.id === id)?.label).filter(Boolean).join(" · ")}</p>}{state.settings.showReason && <small>{run.pendingDecision.decision.reason}</small>}<div className="actions">{run.pendingDecision.decision.selectedOptionIds.length > 0 && <button className="primary" onClick={() => void act(() => runtime({ type: "APPLY_SUGGESTION" }))}>Áp dụng</button>}<button className="secondary" onClick={() => void act(() => runtime({ type: "RETRY_QUESTION" }))}>Thử lại</button><button className="ghost" onClick={() => void act(() => runtime({ type: "SKIP_QUESTION" }))}>Bỏ qua</button></div></article>}
    <div className="control-grid"><button className="stop" disabled={busy || run.status === "paused" || run.status === "completed"} onClick={() => void act(() => runtime({ type: "STOP_RUN" }))}>■ Dừng</button><button className="primary" disabled={busy || !["paused", "error"].includes(run.status)} onClick={() => void act(() => runtime({ type: "RESUME_RUN" }))}>▶ Tiếp tục</button></div>
    <div className="safety">🛡 Extension luôn dừng trước nút “Nộp bài và kết thúc”.</div>
  </section>;
}

function GeminiPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [settings, setSettings] = useState(state.settings);
  const [modelError, setModelError] = useState("");
  useEffect(() => setSettings(state.settings), [state.settings]);
  const loadModels = useCallback(async () => {
    const next = await runtime<GeminiModel[]>({ type: "LIST_MODELS" });
    setModels(next); setModelError("");
    return next;
  }, []);
  useEffect(() => {
    if (!state.apiKeyPresent) { setModels([]); return; }
    void loadModels().catch((error) => setModelError(error instanceof Error ? error.message : String(error)));
  }, [state.apiKeyPresent, loadModels]);
  const saveModel = async (next: AppSettings) => { setSettings(next); await runtime({ type: "SAVE_SETTINGS", settings: next }); };
  const recommendations = recommendedGeminiModels(models);
  return <section><div className="section-head"><div><h2>Kết nối Gemini</h2><p className={state.apiKeyPresent ? "ok" : "warn"}>{state.apiKeyPresent ? "● API key đã lưu" : "● Chưa có API key"}</p></div></div>
    <div className="panel-card form-grid"><label>Gemini API key<div className="input-action"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={state.apiKeyPresent ? "••••••••••••••••" : "Dán API key"} autoComplete="off" /><button disabled={!key.trim() || busy} onClick={() => void act(async () => { await runtime({ type: "SAVE_API_KEY", apiKey: key }); await loadModels(); setKey(""); }, "Đã lưu key và tải danh sách model.")}>Lưu</button></div></label><div className="inline-actions"><button className="secondary" disabled={!state.apiKeyPresent || busy} onClick={() => void act(async () => { const result = await runtime<{ modelCount: number }>({ type: "VALIDATE_API_KEY" }); if (!result.modelCount) throw new Error("Key hợp lệ nhưng không có model tạo nội dung."); await loadModels(); }, "API key hoạt động.")}>Kiểm tra key</button><button className="ghost danger-text" disabled={!state.apiKeyPresent || busy} onClick={() => void act(() => runtime({ type: "DELETE_API_KEY" }), "Đã xóa API key.")}>Xóa key</button></div></div>
    <div className="panel-card form-grid"><div className="field-head"><b>Model đề xuất</b><button className="link" disabled={!state.apiKeyPresent || busy} onClick={() => void act(loadModels, "Đã làm mới danh sách model.")}>↻ Làm mới</button></div><div className="model-suggestions">{recommendations.map((model) => <button key={model.id} className={settings.model === model.id && !settings.customModel ? "selected" : ""} disabled={model.available === false || busy} onClick={() => void act(() => saveModel({ ...settings, model: model.id, customModel: "" }), `Đã chọn ${model.title}.`)}><span><b>{model.title}</b><em>{model.badge}</em></span><small>{model.description}</small>{model.available === false && <i>Key này không có model</i>}</button>)}</div>{modelError && <div className="error-box">{modelError}</div>}<label>Tất cả model khả dụng<select value={settings.model} onChange={(event) => void act(() => saveModel({ ...settings, model: event.target.value, customModel: "" }))}><option value="">Chọn model</option>{settings.model && !models.some((model) => model.id === settings.model) && <option value={settings.model}>{settings.model}</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.id}</option>)}</select></label><label>Hoặc model ID tùy chỉnh<input value={settings.customModel} onChange={(event) => setSettings({ ...settings, customModel: event.target.value })} onBlur={() => void act(() => saveModel(settings))} placeholder="gemini-…" /></label></div>
    <div className="warning-card">API key được lưu cục bộ và không được gửi cho trang TNU. Tuy vậy, chrome.storage.local không phải kho bí mật được mã hóa; chỉ sử dụng trên máy bạn tin cậy.</div>
  </section>;
}

function SettingsPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const source = state.settings;
  const [settings, setSettings] = useState(source);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setSettings(source), [source]);
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  return <section><h2>Cài đặt</h2><div className="panel-card form-grid">
    <label>Ngưỡng tin cậy <b>{Math.round(settings.confidenceThreshold * 100)}%</b><input type="range" min="0.5" max="0.98" step="0.01" value={settings.confidenceThreshold} onChange={(event) => set("confidenceThreshold", Number(event.target.value))} /></label>
    <div className="two-col"><label>Timeout (giây)<input type="number" min="5" max="120" value={settings.timeoutMs / 1000} onChange={(event) => set("timeoutMs", Number(event.target.value) * 1000)} /></label><label>Số lần thử lại<input type="number" min="0" max="5" value={settings.retryCount} onChange={(event) => set("retryCount", Number(event.target.value))} /></label></div>
    <label>Khoảng nghỉ giữa câu (ms)<input type="number" min="0" max="10000" step="50" value={settings.delayMs} onChange={(event) => set("delayMs", Number(event.target.value))} /></label>
    <label>Từ khóa luyện tập<textarea value={settings.practiceKeywords.join(", ")} onChange={(event) => set("practiceKeywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>
    <label>Từ khóa kiểm tra<textarea value={settings.gradedKeywords.join(", ")} onChange={(event) => set("gradedKeywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>
    <Toggle label="Tự chuyển trang" value={settings.autoNavigate} onChange={(value) => set("autoNavigate", value)} />
    <Toggle label="Thông báo hệ thống" value={settings.notificationsEnabled} onChange={(value) => set("notificationsEnabled", value)} />
    <Toggle label="Âm thanh" value={settings.soundEnabled} onChange={(value) => set("soundEnabled", value)} />
    <Toggle label="Hiện giải thích Gemini" value={settings.showReason} onChange={(value) => set("showReason", value)} />
    <label>Khi Gemini phân vân<select value={settings.uncertainMode} onChange={(event) => set("uncertainMode", event.target.value as AppSettings["uncertainMode"])}><option value="reason">Tự suy luận lại một lần</option><option value="ask">Dừng và hỏi tôi</option></select></label>
    {settings.soundEnabled && <label>Âm lượng <b>{Math.round(settings.volume * 100)}%</b><input type="range" min="0.05" max="1" step="0.05" value={settings.volume} onChange={(event) => set("volume", Number(event.target.value))} /></label>}
    <button className="primary" disabled={busy} onClick={() => void act(() => runtime({ type: "SAVE_SETTINGS", settings }), "Đã lưu cài đặt.")}>Lưu cài đặt</button>
  </div><div className="panel-card memory-card"><div><span>✓</span><p><b>Bộ nhớ đáp án đúng</b><small>{state.answerMemoryCount} câu đã học từ trang xem lại sau chấm bài</small></p></div><button className="ghost danger-text" disabled={busy || !state.answerMemoryCount} onClick={() => void act(() => runtime({ type: "CLEAR_ANSWER_MEMORY" }), "Đã xóa bộ nhớ đáp án.")}>Xóa bộ nhớ</button></div>
  <div className="panel-card data-card"><div className="field-head"><b>Quyền riêng tư và dung lượng</b><small>Đang dùng {formatBytes(state.storageBytes)}</small></div><p>Xóa API key khi không sử dụng, hoặc reset toàn bộ để xóa cài đặt, khóa học, hàng đợi, nhật ký, phiên chạy và bộ nhớ đáp án.</p><div className="data-actions"><button className="secondary danger-text" disabled={busy || !state.apiKeyPresent} onClick={() => void act(() => runtime({ type: "DELETE_API_KEY" }), "Đã xóa API key khỏi máy.")}>Xóa API key</button><button className={confirmReset ? "stop confirm" : "ghost danger-text"} disabled={busy} onClick={() => { if (!confirmReset) { setConfirmReset(true); window.setTimeout(() => setConfirmReset(false), 5000); return; } void act(async () => { await runtime({ type: "CLEAR_ALL_DATA" }); setConfirmReset(false); }, "Đã reset toàn bộ dữ liệu extension."); }}>{confirmReset ? "Xác nhận reset toàn bộ" : "Reset toàn bộ"}</button></div>{confirmReset && <small className="reset-warning">Bấm lại trong 5 giây để xác nhận. Thao tác này không thể hoàn tác.</small>}</div></section>;
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle"><span>{label}</span><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function Logs({ state }: { state: AppState }) {
  return <section><div className="section-head"><div><h2>Nhật ký</h2><p>Tối đa 200 sự kiện, không lưu nội dung câu hỏi</p></div></div>{!state.logs.length && <Empty icon="◷" title="Chưa có sự kiện" text="Hoạt động quét, chạy và lỗi sẽ xuất hiện ở đây." />}<div className="log-list">{state.logs.map((log) => <div className={`log ${log.level}`} key={log.id}><i /><div><b>{log.message}</b><small>{new Date(log.at).toLocaleString("vi-VN")}</small></div></div>)}</div></section>;
}

function Empty({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="empty"><span>{icon}</span><h3>{title}</h3><p>{text}</p></div>;
}
