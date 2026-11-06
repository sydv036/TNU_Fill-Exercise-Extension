import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyAssessment, normalizeText } from "../../src/classifier";
import { quizKey } from "../../src/answer-memory";
import { DEFAULT_SETTINGS } from "../../src/defaults";
import { canChangeSelection, selectedModel, selectedProviderModel } from "../../src/ai-selection";
import { estimatePendingUsageUsd, estimateUsageUsd, isValidModelPrice } from "../../src/run-budget";
import { deleteApiKey, deleteProviderKey, saveApiKey, saveProviderKey } from "../../src/storage";
import { PROVIDERS } from "../../src/providers";
import { isWebProvider } from "../../src/web-tabs";
import { groupPracticeTargets, practiceBatchIssue } from "../../src/practice-batch";
import type { AnswerMemorySource, AppSettings, AppState, BrowserTabSummary, GeminiModel, KnowledgeSearchResponse, QuizTarget, RunMode, RunSession, RuntimeMessage, RuntimeResponse, RunStatus, WebProviderId } from "../../src/types";

type TabId = "courses" | "queue" | "run" | "knowledge" | "lecture" | "gemini" | "settings" | "logs";

const EMPTY_STATE: AppState = { settings: DEFAULT_SETTINGS, apiKeyPresent: false, providerKeys: { openai_api: false, anthropic_api: false }, modelCapabilities: [], queue: [], logs: [], answerMemoryCount: 0, answerMemorySources: [], knowledgeIndexes: [], storageBytes: 0, browserTabs: [] };
const TAB_ITEMS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: "courses", label: "Khóa học", icon: "▦" },
  { id: "queue", label: "Hàng đợi", icon: "≡" },
  { id: "run", label: "Đang chạy", icon: "▶" },
  { id: "knowledge", label: "Tài liệu", icon: "⌕" },
  { id: "lecture", label: "Bài giảng", icon: "⏩" },
  { id: "gemini", label: "AI", icon: "✦" },
  { id: "settings", label: "Cài đặt", icon: "⚙" },
  { id: "logs", label: "Nhật ký", icon: "◷" }
];

async function runtime<T = unknown>(message: RuntimeMessage): Promise<T> {
  const response = await browser.runtime.sendMessage(message) as RuntimeResponse<T>;
  if (!response.ok) throw new Error(response.error || "Thao tác thất bại.");
  return response.data as T;
}

async function changeApiCredential(provider: "gemini_api" | "openai_api" | "anthropic_api", key?: string): Promise<void> {
  const { token } = await runtime<{ token: string }>({ type: "BEGIN_CREDENTIAL_CHANGE", provider });
  try {
    if (provider === "gemini_api") key?.trim() ? await saveApiKey(key) : await deleteApiKey();
    else key?.trim() ? await saveProviderKey(provider, key) : await deleteProviderKey(provider);
    await runtime({ type: "COMPLETE_CREDENTIAL_CHANGE", provider, token });
  } catch (error) {
    await runtime({ type: "CANCEL_CREDENTIAL_CHANGE", token }).catch(() => undefined);
    throw error;
  }
}

function statusLabel(status?: RunStatus): string {
  return ({ idle: "Sẵn sàng", scanning: "Đang quét", preparing: "Chuẩn bị", answering: "Đang trả lời", awaiting_user: "Chờ bạn", navigating: "Chuyển trang", paused: "Đã dừng", completed: "Hoàn tất", error: "Có lỗi" } as Record<string, string>)[status || "idle"] ?? "Sẵn sàng";
}

function kindLabel(kind: QuizTarget["assessmentKind"]): string {
  return kind === "practice" ? "Luyện tập" : kind === "graded" ? "Kiểm tra" : "Chưa xác định";
}

function memorySourceLabel(source: AnswerMemorySource): string {
  return `${source.courseName} # ${source.week} # ${source.quizName}`;
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
      {tab === "knowledge" && <KnowledgePanel state={state} busy={busy} act={act} />}
      {tab === "lecture" && <LecturePanel state={state} busy={busy} act={act} />}
      {tab === "gemini" && <GeminiPanel state={state} busy={busy} act={act} />}
      {tab === "settings" && <SettingsPanel state={state} busy={busy} act={act} />}
      {tab === "logs" && <Logs state={state} />}
    </main>
  </div>;
}

function LecturePanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const source = state.settings;
  const [enabled, setEnabled] = useState(source.scormEnabled);
  const [rate, setRate] = useState(source.scormPlaybackRate);
  const [autoNext, setAutoNext] = useState(source.scormAutoNext);
  const [delaySeconds, setDelaySeconds] = useState(source.scormNextDelayMs / 1000);
  const [pauseOnInteraction, setPauseOnInteraction] = useState(source.scormPauseOnInteraction);
  useEffect(() => {
    setEnabled(source.scormEnabled); setRate(source.scormPlaybackRate); setAutoNext(source.scormAutoNext);
    setDelaySeconds(source.scormNextDelayMs / 1000); setPauseOnInteraction(source.scormPauseOnInteraction);
  }, [source.scormEnabled, source.scormPlaybackRate, source.scormAutoNext, source.scormNextDelayMs, source.scormPauseOnInteraction]);
  const save = (nextEnabled = enabled) => runtime({ type: "SCORM_CONTROL", settings: { scormEnabled: nextEnabled, scormPlaybackRate: rate, scormAutoNext: autoNext, scormNextDelayMs: Math.round(delaySeconds * 1000), scormPauseOnInteraction: pauseOnInteraction } });
  const status = state.scormStatus;
  const fresh = Boolean(status && Date.now() - Date.parse(status.updatedAt) < 30_000);
  const percent = status?.duration && status.duration > 0 ? Math.min(100, Math.max(0, ((status.currentTime ?? 0) / status.duration) * 100)) : 0;
  const time = (seconds?: number) => Number.isFinite(seconds) ? `${Math.floor(seconds! / 60)}:${String(Math.floor(seconds! % 60)).padStart(2, "0")}` : "--:--";
  return <section>
    <div className="section-head"><div><h2>Bài giảng điện tử</h2><p>Tăng tốc đồng bộ âm thanh, timeline/hiệu ứng SCORM và tự chuyển slide</p></div></div>
    <div className={`lecture-status ${fresh ? status?.state ?? "idle" : "offline"}`}><div><span>{fresh ? status?.mediaKind === "video" ? "🎬" : "🔊" : "◌"}</span><p><b>{fresh ? status?.message : "Chưa nhận diện bài giảng SCORM đang mở"}</b><small>{fresh ? `Tab ${status?.tabId} · ${status?.playbackRate ?? rate}×` : "Mở Bài giảng điện tử trên TNU rồi tải lại trang sau khi cập nhật extension."}</small></p></div>{fresh && status?.duration !== undefined && <><div className="lecture-progress"><i style={{ width: `${percent}%` }} /></div><small>{time(status.currentTime)} / {time(status.duration)}</small></>}</div>
    <div className="panel-card form-grid">
      <label>Tốc độ phát<select value={rate} onChange={(event) => setRate(Number(event.target.value))}>{[1, 1.5, 2, 3, 4, 6, 8].map((value) => <option key={value} value={value}>{value}×{value > 4 ? " — có thể không nghe rõ tiếng" : ""}</option>)}</select></label>
      <Toggle label="Tự chuyển sang slide tiếp theo" value={autoNext} onChange={setAutoNext} />
      <label>Chờ trước khi chuyển slide (giây)<input type="number" min="0" max="10" step="0.25" value={delaySeconds} onChange={(event) => setDelaySeconds(Math.max(0, Math.min(10, Number(event.target.value))))} /></label>
      <Toggle label="Dừng khi gặp câu hỏi hoặc tương tác" value={pauseOnInteraction} onChange={setPauseOnInteraction} />
      <small className="setting-help">Extension tăng tốc cả đồng hồ hiệu ứng của player và media, nhưng không tua thẳng tới cuối hay ghi giả trạng thái hoàn thành. Nút TIẾP chỉ được bấm sau sự kiện kết thúc thật.</small>
      {rate > 4 && <div className="warning-card">Ở 6×–8×, Chrome có thể phát âm thanh khó nghe hoặc gần như im tiếng. Tiến trình media vẫn chạy nhanh.</div>}
      <div className="lecture-actions"><button className="primary" disabled={busy} onClick={() => void act(async () => { setEnabled(true); await save(true); }, `Đã bật tăng tốc ${rate}×.`)}>{enabled ? "Lưu & áp dụng" : "Bật tăng tốc"}</button><button className="stop" disabled={busy || !enabled} onClick={() => void act(async () => { setEnabled(false); await save(false); }, "Đã dừng tăng tốc bài giảng.")}>Dừng ngay</button></div>
    </div>
    <div className="panel-card lecture-safety"><b>Nguyên tắc hoạt động</b><p>Slide không có media, media lỗi, nút TIẾP bị khóa hoặc có tương tác sẽ không bị tự bỏ qua. Ở slide cuối, gói SCORM của TNU tự quyết định trạng thái hoàn thành.</p></div>
  </section>;
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
          <span className="course-icon">▤</span><span><b>{course.name}</b><small>{course.category} · {course.weeks.reduce((sum, week) => sum + week.activities.length, 0)} bài · {course.weeks.reduce((sum, week) => sum + (week.materials?.length ?? 0), 0)} tài liệu</small></span><i>{expanded.includes(course.id) ? "⌃" : "⌄"}</i>
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
  const [webTabs, setWebTabs] = useState<BrowserTabSummary[]>(state.browserTabs ?? []);
  const [tnuTabId, setTnuTabId] = useState<number | undefined>(state.webTabBinding?.tnuTabId);
  const [aiTabId, setAiTabId] = useState<number | undefined>(state.webTabBinding?.aiTabId);
  const [webProvider, setWebProvider] = useState<WebProviderId>(state.webTabBinding?.providerId ?? "chatgpt_web");
  const [dryRun, setDryRun] = useState(false);
  const [dryRunLimit, setDryRunLimit] = useState(3);
  const refreshTabs = useCallback(async () => {
    const valid = await runtime<BrowserTabSummary[]>({ type: "LIST_WEB_TABS" });
    setWebTabs(valid);
    setTnuTabId((current) => valid.some((tab) => tab.kind === "tnu" && tab.id === current) ? current : valid.find((tab) => tab.kind === "tnu")?.id);
    setAiTabId((current) => valid.some((tab) => tab.kind === "ai" && tab.providerId === webProvider && tab.id === current) ? current : valid.find((tab) => tab.kind === "ai" && tab.providerId === webProvider)?.id);
  }, [webProvider]);
  useEffect(() => { setWebTabs(state.browserTabs ?? []); }, [state.browserTabs]);
  useEffect(() => {
    if (state.webTabBinding) {
      setTnuTabId(state.webTabBinding.tnuTabId); setAiTabId(state.webTabBinding.aiTabId); setWebProvider(state.webTabBinding.providerId);
    }
  }, [state.webTabBinding]);
  useEffect(() => {
    if (!isWebProvider(state.settings.provider)) return;
    if (state.webTabBinding?.providerId === state.settings.provider) return;
    setWebProvider(state.settings.provider);
    setAiTabId((state.browserTabs ?? []).find((item) => item.kind === "ai" && item.providerId === state.settings.provider)?.id);
  }, [state.settings.provider, state.webTabBinding?.providerId, state.browserTabs]);
  useEffect(() => { void refreshTabs(); }, [refreshTabs]);
  const [preparing, setPreparing] = useState<{ targetId: string; mode: RunMode }>();
  const [memorySourceQuizKeys, setMemorySourceQuizKeys] = useState<string[]>([]);
  const [reviewEveryAnswer, setReviewEveryAnswer] = useState(false);
  const [knowledgeMaterialIds, setKnowledgeMaterialIds] = useState<string[]>([]);
  const [selectedPracticeIds, setSelectedPracticeIds] = useState<string[]>([]);
  const [preparedBatchTargets, setPreparedBatchTargets] = useState<QuizTarget[]>();
  const availableMaterials = (target: QuizTarget) => {
    const indexedIds = new Set(state.knowledgeIndexes.find((index) => index.courseId === target.courseId)?.indexedMaterialIds ?? []);
    return state.courseIndex?.courses.find((course) => course.id === target.courseId)?.weeks.flatMap((week) => week.materials ?? []).filter((material) => indexedIds.has(material.id)) ?? [];
  };
  const remove = (id: string) => act(() => runtime({ type: "SAVE_QUEUE", queue: state.queue.filter((item) => item.id !== id) }));
  const prepare = (target: QuizTarget, mode: RunMode, batchTargets?: QuizTarget[]) => {
    const sources = state.answerMemorySources.filter((source) => source.courseId === target.courseId);
    const exactSource = sources.find((source) => source.quizKey === quizKey(target));
    setMemorySourceQuizKeys(exactSource ? [exactSource.quizKey] : []);
    setReviewEveryAnswer(target.assessmentKind !== "practice");
    const materials = availableMaterials(target);
    setKnowledgeMaterialIds(state.settings.useCourseKnowledgeForAnswers ? materials.map((material) => material.id) : []);
    setPreparedBatchTargets(batchTargets);
    setPreparing({ targetId: target.id, mode });
  };
  const start = (target: QuizTarget, mode: RunMode) => act(async () => {
    if (tnuTabId === undefined) throw new Error("Hãy mở và chọn tab TNU trước khi bắt đầu.");
    await runtime({ type: "START_RUN", target, mode, memorySourceQuizKeys, reviewEveryAnswer, knowledgeMaterialIds, batchTargets: preparedBatchTargets, tnuTabId, dryRunLimit: dryRun ? dryRunLimit : undefined });
    setPreparing(undefined);
    setPreparedBatchTargets(undefined);
    setTab("run");
  });
  const selectedPractices = state.queue.filter((target) => selectedPracticeIds.includes(target.id) && target.assessmentKind === "practice");
  const practiceGroups = groupPracticeTargets(state.queue);
  const batchIssue = selectedPractices.length ? practiceBatchIssue(selectedPractices) : undefined;
  const selectedCourseId = selectedPractices[0]?.courseId;
  const tnuTabs = webTabs.filter((item) => item.kind === "tnu");
  const aiTabs = webTabs.filter((item) => item.kind === "ai" && item.providerId === webProvider);
  const connection = webTabs.find((item) => item.id === aiTabId);
  const activeWebProvider = ["chatgpt_web", "claude_web", "gemini_web", "deepseek_web"].includes(state.settings.provider);
  const webReady = connection?.integrationStatus === "ready" && connection.providerId === state.settings.provider;
  return <section><div className="section-head"><div><h2>Hàng đợi</h2><p>{state.queue.length} bài trong hàng đợi · {selectedPractices.length} bài trong chuỗi</p></div>{selectedPractices.length > 0 && <button className="primary compact" disabled={busy || Boolean(batchIssue)} title={batchIssue ?? ""} onClick={() => prepare(selectedPractices[0]!, "from_start", selectedPractices)}>Chạy chuỗi {selectedPractices.length} bài</button>}</div>
    {practiceGroups.length > 0 && <div className="panel-card batch-course-picker"><b>Chọn chuỗi theo từng môn</b><small>Một chuỗi chỉ chạy các bài trong cùng một môn để cache và tài liệu không bị trộn.</small><div>{practiceGroups.map((group) => { const selectedCount = group.targets.filter((target) => selectedPracticeIds.includes(target.id)).length; return <button type="button" className={selectedCount === group.targets.length ? "primary" : "secondary"} key={group.courseId} disabled={busy} onClick={() => setSelectedPracticeIds(group.targets.map((target) => target.id))}><span>{group.courseName}</span><small>{selectedCount}/{group.targets.length} bài</small></button>; })}</div>{selectedPractices.length > 0 && <button type="button" className="ghost compact" disabled={busy} onClick={() => setSelectedPracticeIds([])}>Bỏ chọn chuỗi</button>}</div>}
    {batchIssue && <div className="warning-card batch-warning"><b>Chưa thể chạy chuỗi:</b> {batchIssue} Hãy bấm tên một môn ở trên để chọn lại đúng nhóm.</div>}
    {activeWebProvider && <div className={webReady ? "ok-card" : "warning-card"}>{webReady ? `${connection?.fixture ? "Fixture" : "AI Web"} đã được nhận diện. Hãy liên kết đúng hai tab và kiểm tra editor trước khi chạy.` : "Hãy chọn đúng provider, tab TNU và tab AI rồi bấm Liên kết hai tab."} Cấu hình Gemini API vẫn được giữ nguyên và có thể chọn thay thế.</div>}
    <div className="panel-card form-grid"><b>Liên kết hai tab trong profile Chrome hiện tại</b><label>Tab TNU<select value={tnuTabId ?? ""} onChange={(event) => setTnuTabId(event.target.value ? Number(event.target.value) : undefined)}><option value="">Chọn tab TNU</option>{tnuTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title} · {tab.domain} · cửa sổ {tab.windowId} · tab {tab.id}</option>)}</select></label><label>AI Web<select value={webProvider} onChange={(event) => { const next = event.target.value as WebProviderId; setWebProvider(next); setAiTabId(webTabs.find((tab) => tab.kind === "ai" && tab.providerId === next)?.id); }}><option value="chatgpt_web">ChatGPT Web</option><option value="claude_web">Claude Web</option><option value="gemini_web">Gemini Web</option><option value="deepseek_web">DeepSeek Web</option></select></label><label>Tab AI<select value={aiTabId ?? ""} onChange={(event) => setAiTabId(event.target.value ? Number(event.target.value) : undefined)}><option value="">Chọn tab AI</option>{aiTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title} · {tab.domain} · cửa sổ {tab.windowId} · tab {tab.id}</option>)}</select></label><div className="inline-actions"><button className="secondary" onClick={() => void act(refreshTabs)}>Làm mới danh sách tab</button><button className="secondary" disabled={busy || tnuTabId === undefined || aiTabId === undefined} onClick={() => void act(() => runtime({ type: "BIND_WEB_TABS", tnuTabId: tnuTabId!, aiTabId: aiTabId!, providerId: webProvider }), "Đã liên kết chính xác hai tab trong profile hiện tại.")}>Liên kết hai tab</button><button className="ghost" disabled={busy || !state.webTabBinding} onClick={() => void act(async () => { const result = await runtime<{ valid: boolean; reason?: string }>({ type: "CHECK_WEB_TAB_BINDING" }); if (!result.valid) throw new Error(result.reason || "Binding không còn hợp lệ."); }, "Editor AI Web và tab binding đã sẵn sàng.")}>Kiểm tra liên kết</button></div>{state.webTabBinding && <small>Đã bind TNU #{state.webTabBinding.tnuTabId} / cửa sổ {state.webTabBinding.tnuWindowId} với {state.webTabBinding.providerId} #{state.webTabBinding.aiTabId} / cửa sổ {state.webTabBinding.aiWindowId}.</small>}{connection && <div className={connection.integrationStatus === "ready" ? (connection.fixture ? "warning-card" : "ok-card") : "error-box"}>{connection.integrationStatus === "ready" ? connection.fixture ? "Fixture cục bộ đã sẵn sàng." : "Tab AI Web thật đã được nhận diện; bấm Kiểm tra liên kết để xác minh editor và đăng nhập." : "Content bridge chưa nhận diện được website này."}</div>}<small>Danh sách chỉ gồm tab trong cùng profile Chrome mà extension này có thể nhìn thấy. Chuyển focus giữa cửa sổ không làm đổi binding; đóng/reload tab sẽ yêu cầu bind lại.</small><label><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /> Chạy thử, không điền đáp án</label>{dryRun && <label>Số câu chạy thử (1–20)<input type="number" min="1" max="20" value={dryRunLimit} onChange={(event) => setDryRunLimit(Number(event.target.value))} /></label>}</div>
    {!state.queue.length && <Empty icon="≡" title="Hàng đợi đang trống" text="Thêm bài từ danh sách khóa học hoặc form nhập thủ công." />}
    {state.queue.map((target) => {
      const sources = state.answerMemorySources.filter((source) => source.courseId === target.courseId);
      const materials = availableMaterials(target);
      const isPreparing = preparing?.targetId === target.id;
      const selectedForBatch = selectedPracticeIds.includes(target.id);
      const belongsToSelectedCourse = !selectedCourseId || target.courseId === selectedCourseId;
      return <article className="queue-card" key={target.id}><div className="queue-top"><span className={`pill ${target.assessmentKind}`}>{kindLabel(target.assessmentKind)}</span><span className="queue-tools">{target.assessmentKind === "practice" && <label className={`batch-check${!selectedForBatch && !belongsToSelectedCourse ? " unavailable" : ""}`} title={!selectedForBatch && !belongsToSelectedCourse ? "Bài này thuộc môn khác. Bấm nhóm môn ở phía trên để đổi chuỗi." : ""}><input type="checkbox" checked={selectedForBatch} disabled={busy || (!selectedForBatch && !belongsToSelectedCourse)} onChange={(event) => setSelectedPracticeIds((current) => event.target.checked ? [...new Set([...current, target.id])] : current.filter((id) => id !== target.id))} />{!selectedForBatch && !belongsToSelectedCourse ? "Khác môn" : "Chuỗi luyện tập"}</label>}<button className="icon-button danger" onClick={() => void remove(target.id)}>×</button></span></div><h3>{target.name}</h3><p>{target.courseName}</p><small>{target.week}</small>
        {isPreparing ? <div className="memory-source-picker"><div className="cache-source-picker"><b>Nguồn đáp án đã làm trước đó</b>{sources.length ? <div>{sources.map((source) => <label key={source.quizKey}><input type="checkbox" checked={memorySourceQuizKeys.includes(source.quizKey)} onChange={(event) => setMemorySourceQuizKeys((current) => event.target.checked ? [...new Set([...current, source.quizKey])] : current.filter((key) => key !== source.quizKey))} /><span>{memorySourceLabel(source)} <small>({source.answerCount} câu)</small></span></label>)}</div> : <small>Chưa có cache của môn này.</small>}<p>{memorySourceQuizKeys.length ? `Đã chọn ${memorySourceQuizKeys.length} kho cache. Cache mâu thuẫn sẽ không được tự dùng.` : "Không chọn cache — hỏi AI."}</p></div><div className="knowledge-attachment-picker"><div><b>Tài liệu đưa cho AI đọc và kiểm tra</b>{materials.length > 0 && <span><button type="button" onClick={() => setKnowledgeMaterialIds(materials.map((material) => material.id))}>Chọn tất cả</button><button type="button" onClick={() => setKnowledgeMaterialIds([])}>Bỏ chọn</button></span>}</div>{materials.length ? <div className="knowledge-options">{materials.map((material) => <label key={material.id}><input type="checkbox" checked={knowledgeMaterialIds.includes(material.id)} onChange={(event) => setKnowledgeMaterialIds((current) => event.target.checked ? [...new Set([...current, material.id])] : current.filter((id) => id !== material.id))} /><span><b>{material.week} # {material.name}</b><small>{material.kind === "slide" ? "Slide" : material.kind === "textbook" ? "Giáo trình" : material.kind === "lecture" ? "Bài giảng" : "Tài liệu"}</small></span></label>)}</div> : <small>Chưa có tài liệu đã lập chỉ mục. Vào tab Tài liệu để lập chỉ mục trước.</small>}<p>{knowledgeMaterialIds.length ? `Đã đính kèm ${knowledgeMaterialIds.length} tài liệu. Chỉ các tài liệu này được gửi theo từng đoạn liên quan${preparedBatchTargets ? "; chuỗi vẫn tự chạy liên tục." : "; bạn có thể chọn dừng từng câu để kiểm tra."}` : "Không đính kèm — AI sẽ không dùng tài liệu để trả lời hoặc kiểm tra lại."}</p></div>{preparedBatchTargets && <div className="batch-summary"><b>Chuỗi {preparedBatchTargets.length} bài luyện tập</b><span>{preparedBatchTargets.map((item) => `${item.week} # ${item.name}`).join(" → ")}</span><small>Tự áp dụng mọi đáp án hợp lệ, không dừng vì Gemini phân vân. Tool chỉ dừng để bạn tự nộp; sau trang xem lại sẽ tự chuyển bài kế tiếp.</small></div>}{preparedBatchTargets ? <div className="batch-auto-note">⚡ Thu thập cache tự động — không hỏi xác nhận từng câu.</div> : <label className="review-every-answer"><input type="checkbox" checked={reviewEveryAnswer} disabled={target.assessmentKind !== "practice"} onChange={(event) => setReviewEveryAnswer(event.target.checked)} /><span>Dừng từng câu để có thể bấm “Kiểm tra lại”{target.assessmentKind !== "practice" ? " (bắt buộc với bài kiểm tra)" : ""}</span></label>}<div className="actions"><button className="primary" disabled={busy} onClick={() => void start(target, preparing.mode)}>Xác nhận bắt đầu</button><button className="ghost" disabled={busy} onClick={() => { setPreparing(undefined); setPreparedBatchTargets(undefined); }}>Hủy</button></div></div>
          : <div className="actions"><button className="primary" disabled={busy} onClick={() => prepare(target, "from_start")}>Bắt đầu</button><button className="secondary" disabled={busy} onClick={() => prepare(target, "from_current")}>Từ câu hiện tại</button></div>}
      </article>;
    })}
  </section>;
}

function RunPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const run = state.run;
  if (!run) return <section><h2>Đang chạy</h2><Empty icon="▶" title="Chưa có phiên chạy" text="Chọn một bài trong Hàng đợi để bắt đầu." /></section>;
  const estimate = estimateUsageUsd(run.usage, run.settingsSnapshot?.modelPrices ?? []);
  const pendingEstimate = estimatePendingUsageUsd(run.usage);
  const pendingInputTokens = run.usage?.pending?.reduce((total, item) => total + (item.inputTokens ?? 0), 0) ?? 0;
  const pendingOutputTokens = run.usage?.pending?.reduce((total, item) => total + (item.outputTokens ?? 0), 0) ?? 0;
  const unknownUsage = run.usage?.pending?.filter((item) => item.status === "unknown") ?? [];
  const budget = run.settingsSnapshot ?? state.settings;
  const usedPrices = (run.usage?.byModel ?? []).map((item) => ({ provider: item.provider, model: item.model }));
  if (!usedPrices.length && run.provider && ["gemini_api", "openai_api", "anthropic_api"].includes(run.provider)) usedPrices.push({ provider: run.provider as "gemini_api" | "openai_api" | "anthropic_api", model: selectedProviderModel(budget, run.provider) });
  const missingCurrentPrice = usedPrices.some(({ provider, model }) => !budget.modelPrices.some((price) => price.provider === provider && price.model === model && isValidModelPrice(price) && Date.now() - Date.parse(`${price.checkedOn}T00:00:00Z`) >= -86400000 && Date.now() - Date.parse(`${price.checkedOn}T00:00:00Z`) <= 30 * 86400000));
  const nearLimit = Boolean((budget.maxRequests && (run.usage?.requests ?? 0) >= budget.maxRequests * 0.8) || (budget.maxTokens && ((run.usage?.totalTokens ?? 0) + pendingInputTokens + pendingOutputTokens) >= budget.maxTokens * 0.8) || (budget.maxCostUsd && estimate !== undefined && pendingEstimate !== undefined && estimate + pendingEstimate >= budget.maxCostUsd * 0.8));
  const progress = run.totalOnPage ? Math.round((Math.max(0, run.currentQuestion - 1) / run.totalOnPage) * 100) : 0;
  const visibleQuestion = run.pendingDecision?.question ?? run.currentQuestionSnapshot;
  const suggestedIds = new Set(run.pendingDecision?.decision.selectedOptionIds ?? []);
  const selectedMemoryKeys = run.memorySourceQuizKeys ?? (run.memorySourceQuizKey ? [run.memorySourceQuizKey] : []);
  const memorySources = state.answerMemorySources.filter((source) => selectedMemoryKeys.includes(source.quizKey));
  const selectedKnowledgeMaterials = state.courseIndex?.courses.find((course) => course.id === run.target.courseId)?.weeks.flatMap((week) => week.materials ?? []).filter((material) => run.knowledgeMaterialIds?.includes(material.id)) ?? [];
  const optionLabels = (ids: string[]) => ids.map((id) => visibleQuestion?.options.find((option) => option.id === id)?.label ?? id).join(" · ");
  const canApplyPending = run.status === "awaiting_user" && !run.pendingDecision?.decision.manualRequestId && Boolean(run.pendingDecision?.decision.selectedOptionIds.length)
    && (run.target.assessmentKind === "practice" || run.pendingDecision?.decision.verification?.status === "agreed");
  return <section><div className="run-hero"><span className={`pill ${run.target.assessmentKind}`}>{kindLabel(run.target.assessmentKind)}</span><h2>{run.target.name}</h2><p>{run.target.courseName} · {run.target.week}</p></div>
    <div className="panel-card"><b>AI đã chọn: {PROVIDERS.find((item) => item.id === state.settings.provider)?.label}</b>{PROVIDERS.find((item) => item.id === state.settings.provider)?.mode === "api" && <p>Model đã chọn: {selectedProviderModel(state.settings) || "chưa chọn"}</p>}<small>Cấu hình phiên {run.status === "paused" ? "trước khi dừng" : "đang dùng"}: {PROVIDERS.find((item) => item.id === run.provider)?.label || run.provider || "chưa xác định"}{run.provider && run.settingsSnapshot && selectedProviderModel(run.settingsSnapshot, run.provider) ? ` · ${selectedProviderModel(run.settingsSnapshot, run.provider)}` : ""}. Khi tiếp tục, phiên sẽ dùng cấu hình đã chọn.</small></div>
    <div className="panel-card">
      <b>Ngân sách phiên</b>
      {nearLimit && <p className="warn">Đã đạt ít nhất 80% một ngưỡng ngân sách.</p>}
      <p>{run.usage?.requests ?? 0} yêu cầu đã gửi · {run.usage?.fallbackCount ?? 0} lần chuyển dự phòng · {run.usage?.pending?.length ?? 0} lượt đang chờ</p>
      <small>Token đã xác nhận: {run.usage?.totalTokens ?? 0} (đầu vào {run.usage?.inputTokens ?? 0}, đầu ra {run.usage?.outputTokens ?? 0}) · chưa rõ usage: {run.usage?.unknownUsageRequests ?? 0}.</small>
      <small>Ước tính đã xác nhận: {estimate === undefined ? "chưa đủ dữ liệu hoặc giá hết hạn" : `$${estimate.toFixed(6)}`} · đang tạm giữ: {pendingEstimate === undefined ? "chưa ước lượng được" : `$${pendingEstimate.toFixed(6)}`} · token tạm giữ: {pendingInputTokens + pendingOutputTokens}.</small>
      {missingCurrentPrice && <small className="warn">Chưa có giá hợp lệ trong 30 ngày cho tất cả model đã dùng; không thể xác nhận chính xác chi phí.</small>}
      {budget.maxCostUsd > 0 && (estimate === undefined || pendingEstimate === undefined) && <small className="warn">Không thể kiểm tra đầy đủ ngưỡng chi phí. Chính sách hiện tại: {budget.unknownUsagePolicy === "stop" ? "dừng trước yêu cầu tiếp theo" : "tiếp tục khi thiếu ước lượng"}.</small>}
      {run.lastError && <small className="warn">Lỗi gần nhất: {run.lastError.provider} · {run.lastError.providerCode ?? run.lastError.kind}{run.lastError.status ? ` · HTTP ${run.lastError.status}` : ""}.</small>}
      {run.usage?.byModel.map((item) => <p key={`${item.provider}:${item.model}`}><small>{item.provider} · {item.model}: {item.requests} lượt, {item.totalTokens} token đã xác nhận</small></p>)}
      {unknownUsage.length > 0 && <div className="unknown-usage">
        <b className="warn">Có {unknownUsage.length} request chưa xác định usage. Extension sẽ không tự gửi lại.</b>
        {unknownUsage.map((item) => <div className="unknown-usage-item" key={item.id}>
          <small>{item.provider} · {item.model} · {item.questionId ?? item.requestId} · dự toán {item.inputTokens === undefined || item.outputTokens === undefined ? "chưa đủ dữ liệu" : `${item.inputTokens + item.outputTokens} token`}</small>
          <div className="inline-actions">
            <button className="secondary" disabled={busy || !item.requestId} onClick={() => { if (window.confirm("Chỉ chọn nếu bạn đã đối chiếu lịch sử nhà cung cấp và xác nhận request này không bị tính usage. Request count vẫn được giữ vì có thể đã gửi.")) void act(() => runtime({ type: "RESOLVE_UNKNOWN_USAGE", requestId: item.requestId!, resolution: "not_charged" }), "Đã đối soát: usage không bị tính."); }}>Đã xác nhận không tính usage</button>
            <button className="secondary" disabled={busy || !item.requestId} onClick={() => { if (window.confirm("Dự toán bảo thủ sẽ được giữ trong ngân sách và câu này sẽ không được gửi lại tự động. Tiếp tục?")) void act(() => runtime({ type: "RESOLVE_UNKNOWN_USAGE", requestId: item.requestId!, resolution: "count_estimate" }), "Đã giữ dự toán bảo thủ."); }}>Giữ dự toán, khóa gửi lại</button>
          </div>
        </div>)}
      </div>}
      <small>Ước lượng nội bộ có tính dự phòng; nhà cung cấp có thể tính khác, đây không phải hard spending limit hay hóa đơn.</small>
    </div>
    {run.activeExecution && <div className="panel-card"><small>Yêu cầu hiện tại: {PROVIDERS.find((item) => item.id === run.activeExecution?.providerId)?.label}{run.activeExecution.modelId ? ` · ${run.activeExecution.modelId}` : ""} · {run.activeExecution.status === "waiting" ? "đang chờ" : run.activeExecution.status === "dispatching" ? "đang gửi" : run.activeExecution.status === "in_flight" ? "đang chờ phản hồi" : run.activeExecution.status === "unknown" ? "chưa xác định kết quả" : "đã nhận kết quả"}</small></div>}
    {run.webUnknownRequestId && <div className="unknown-usage"><b className="warn">AI Web đã nhận request nhưng chưa xác định được phản hồi. Extension sẽ không gửi lại tự động.</b><p>Kiểm tra tab AI. Nếu không có câu trả lời cho câu này, nút dưới đây sẽ tạo chat mới trước khi cho phép tiếp tục.</p><button className="secondary" disabled={busy} onClick={() => { if (window.confirm("Chỉ xác nhận sau khi đã kiểm tra tab AI và xác nhận không có câu trả lời cho request này. Extension sẽ tạo chat mới và KHÔNG gửi lại cho đến khi bạn bấm Tiếp tục.")) void act(() => runtime({ type: "RESOLVE_UNKNOWN_WEB", requestId: run.webUnknownRequestId!, resolution: "confirmed_no_reply" }), "Đã tạo chat mới. Bạn có thể tiếp tục phiên."); }}>Tôi đã kiểm tra, không có phản hồi — tạo chat mới</button></div>}
    <div className={`memory-source-mode ${memorySources.length ? "selected" : "disabled"}`}>{memorySources.length ? `✓ Đối chiếu ${memorySources.length} cache: ${memorySources.map(memorySourceLabel).join(" · ")}` : "Không chọn phần đáp án cũ — câu hỏi sẽ chuyển sang AI"}</div>
    {run.dryRunLimit && <div className="batch-auto-note">Chạy thử: {run.dryRunCount ?? 0}/{run.dryRunLimit} câu đã ghi nhận; không điền đáp án.</div>}
    {run.practiceAutomation && <div className="panel-card full-score-status"><b>🎯 Tự động đạt điểm tối đa</b><p>Lần làm <strong>{run.practiceAutomation.attemptNumber}/{run.practiceAutomation.maxAttempts}</strong> · {run.practiceAutomation.scoreHistory.length ? `Điểm gần nhất ${run.practiceAutomation.scoreHistory.at(-1)?.label}` : "chưa có điểm"}</p><small>{run.practiceAutomation.autoSubmit ? "Tự nộp đang bật." : "Tự nộp đang tắt — extension sẽ chờ bạn xác nhận."} {run.practiceAutomation.collectCacheWhenFull ? "Đã đủ điểm vẫn chạy để lấy cache." : "Đã đủ điểm sẽ bỏ qua."} Retry AI Web tối đa {run.practiceAutomation.webRetryCount} lần/câu.</small></div>}
    {run.practiceBatch && <div className="batch-progress">Chuỗi luyện tập: bài {run.practiceBatch.currentIndex + 1}/{run.practiceBatch.targets.length} · {run.target.name}</div>}
    {run.practiceBatch ? <div className="batch-auto-note">⚡ Đang thu thập cache tự động — không hỏi xác nhận từng câu.</div> : run.reviewEveryAnswer && <div className="double-check-mode">🛡 Chế độ kiểm tra kép: dừng ở từng câu, chỉ áp dụng khi bạn xác nhận.</div>}
    <div className={`answer-source-mode ${selectedKnowledgeMaterials.length ? "with-docs" : "reason-only"}`}>{selectedKnowledgeMaterials.length ? <><b>📚 AI đang đọc {selectedKnowledgeMaterials.length} tài liệu đã chọn</b><small>{selectedKnowledgeMaterials.map((material) => `${material.week} # ${material.name}`).join(" · ")}</small></> : "🧠 Không đính kèm tài liệu — AI tự suy luận"}</div>
    <div className="progress-card"><div className="progress-label"><span>Trang {run.page}</span><b>{run.currentQuestion}/{run.totalOnPage || "–"} câu</b></div><div className="progress"><i style={{ width: `${progress}%` }} /></div><p>{run.message}</p>{run.error && <div className="error-box">{run.error}</div>}</div>
    {run.provider && run.provider !== "gemini_api" && <div className="panel-card"><b>{isWebProvider(run.provider) ? run.webFixture ? "AI Web fixture" : "AI Web tự động" : "AI Web thủ công"}: {run.provider.replace("_manual", "").replace("_web", "")}</b><p>Đã ghi nhận {isWebProvider(run.provider) ? run.webCompletedCount ?? 0 : run.manualConversationCount ?? 0} câu trong chat hiện tại.</p>{isWebProvider(run.provider) ? <button className="secondary" disabled={busy || Boolean(run.webUnknownRequestId) || ["dispatching", "in_flight"].includes(run.activeExecution?.status ?? "")} onClick={() => { if (window.confirm("Tạo một chat AI Web mới? Các câu tiếp theo sẽ dùng chat mới.")) void act(() => runtime({ type: "CREATE_WEB_CONVERSATION", runId: run.id }), "Đã tạo và xác minh chat AI Web mới."); }}>Tạo chat mới</button> : <button className="secondary" disabled={busy || Boolean(run.pendingDecision?.decision.manualRequestId)} onClick={() => { if (window.confirm("Bạn đã tự tạo chat mới trong trang AI? Bộ đếm sẽ được đặt lại.")) void act(() => runtime({ type: "MANUAL_NEW_CHAT", runId: run.id }), "Đã đặt lại bộ đếm chat."); }}>Tôi đã tạo chat mới</button>}</div>}
    {visibleQuestion && <article className="question-preview"><div><span>{visibleQuestion.number}</span><small>{visibleQuestion.type === "multiple" ? "Chọn nhiều đáp án" : visibleQuestion.type === "truefalse" ? "Đúng / Sai" : visibleQuestion.type === "unsupported" ? "Cần làm thủ công" : "Chọn một đáp án"}</small></div><h3>{visibleQuestion.prompt || "Câu hỏi không có nội dung chữ"}</h3><div className="preview-options">{visibleQuestion.options.map((option) => <div key={option.id} className={suggestedIds.has(option.id) ? "suggested" : option.selected ? "selected" : ""}><i>{visibleQuestion.type === "multiple" ? "□" : "○"}</i><span>{option.label}</span>{suggestedIds.has(option.id) && <b>Gợi ý</b>}</div>)}</div></article>}
    {!run.practiceBatch && <div className="quick-mode"><span>Khi AI phân vân</span><div>{(["reason", "ask"] as const).map((mode) => <button key={mode} className={(run.settingsSnapshot?.uncertainMode ?? state.settings.uncertainMode) === mode ? "active" : ""} onClick={() => void act(async () => {
      await runtime({ type: "SAVE_SETTINGS", settings: { ...state.settings, uncertainMode: mode } });
      if (run.settingsSnapshot) await runtime({ type: "UPDATE_RUN", runId: run.id, executionEpoch: run.executionEpoch, patch: { settingsSnapshot: { ...run.settingsSnapshot, uncertainMode: mode } } });
      const pending = run.pendingDecision?.decision;
      if (mode === "reason" && run.status === "awaiting_user" && run.target.assessmentKind === "practice"
        && !run.reviewEveryAnswer && !run.dryRunLimit && !pending?.manualRequestId && Boolean(pending?.selectedOptionIds.length)) {
        await runtime<void>({ type: "APPLY_SUGGESTION" });
      }
    }, mode === "reason" ? "Đã bật tự suy luận và tiếp tục tự động." : "Đã chuyển sang hỏi bạn.")}>{mode === "reason" ? "✦ Tự suy luận" : "? Hỏi tôi"}</button>)}</div></div>}
    {run.status === "awaiting_user" && run.pendingDecision?.decision.manualRequestId && <ManualRequest run={run} busy={busy} act={act} />}
    {run.pendingDecision && <article className="suggestion"><div><span>{run.pendingDecision.decision.verification?.status === "agreed" ? "Đã kiểm tra kép" : run.pendingDecision.decision.verification ? "Kiểm tra kép chưa an toàn" : run.pendingDecision.decision.selectedOptionIds.length ? (run.pendingDecision.decision.source === "memory" ? "Từ bộ nhớ đáp án" : run.pendingDecision.decision.source === "manual" ? "Gợi ý AI Web" : run.pendingDecision.decision.reasoningPass ? "AI đã suy luận lại" : "Gợi ý AI") : "Cần bạn xử lý"}</span><b>{Math.round(run.pendingDecision.decision.confidence * 100)}%</b></div><h3>{run.pendingDecision.question.number}</h3>{run.pendingDecision.decision.selectedOptionIds.length > 0 && <p>{optionLabels(run.pendingDecision.decision.selectedOptionIds)}</p>}{run.pendingDecision.decision.verification && <div className={`verification-result ${run.pendingDecision.decision.verification.status}`}><b>{run.pendingDecision.decision.verification.status === "agreed" ? "✓ Hai nguồn đồng thuận" : run.pendingDecision.decision.verification.status === "conflict" ? "⚠ Hai nguồn mâu thuẫn" : "? AI chưa đủ chắc chắn"}</b><span><strong>{run.pendingDecision.decision.verification.primarySource === "memory" ? "Cache đã chọn" : "Gợi ý ban đầu"}</strong>{optionLabels(run.pendingDecision.decision.verification.primaryOptionIds)}</span><span><strong>AI phân tích lại · {Math.round(run.pendingDecision.decision.verification.verifierConfidence * 100)}%</strong>{optionLabels(run.pendingDecision.decision.verification.verifierOptionIds)}</span></div>}{run.pendingDecision.decision.verification?.status === "uncertain" && <div className="manual-confirm-actions"><button className="confirm-answer" disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "CONFIRM_VERIFICATION", choice: "primary" }))}>✓ Xác nhận & tiếp tục</button></div>}{run.pendingDecision.decision.verification?.status === "conflict" && <div className="manual-confirm-actions conflict"><button disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "CONFIRM_VERIFICATION", choice: "primary" }))}>Chọn gợi ý ban đầu</button><button disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "CONFIRM_VERIFICATION", choice: "verifier" }))}>Chọn AI kiểm tra lại</button></div>}{state.settings.showReason && <small>{run.pendingDecision.decision.reason}</small>}<div className="actions">{canApplyPending && <button className="primary" disabled={busy} onClick={() => void act(() => runtime({ type: "APPLY_SUGGESTION" }))}>{run.dryRunLimit ? "Ghi nhận chạy thử" : "Áp dụng"}</button>}{(run.pendingDecision.decision.selectedOptionIds.length > 0 || run.pendingDecision.decision.verification) && <button className="secondary verify" disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "VERIFY_QUESTION" }))}>✦ Kiểm tra lại</button>}{!run.pendingDecision.decision.selectedOptionIds.length && !run.pendingDecision.decision.verification && <button className="secondary" disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "RETRY_QUESTION" }))}>Thử lại</button>}<button className="ghost" disabled={busy || run.status !== "awaiting_user"} onClick={() => void act(() => runtime({ type: "SKIP_QUESTION" }))}>Bỏ qua</button></div></article>}
    {unknownUsage.length > 0 && <p className="warn">Hãy đối soát usage ở trên trước khi tiếp tục. Request mơ hồ không được tự gửi lại.</p>}
    {run.status === "awaiting_user" && run.practiceAutomation?.submitPhase === "ready" && <button className="primary submit-practice" disabled={busy} onClick={() => { if (window.confirm("Nộp bài luyện tập này để Moodle chấm điểm và tiếp tục quy trình?")) void act(() => runtime({ type: "SUBMIT_PRACTICE", executionEpoch: run.executionEpoch }), "Đang nộp bài luyện tập..."); }}>Nộp và tiếp tục</button>}
    <div className="control-grid"><button className="stop" disabled={busy || run.status === "paused" || run.status === "completed"} onClick={() => void act(() => runtime({ type: "STOP_RUN" }))}>■ Dừng</button><button className="primary" disabled={busy || unknownUsage.length > 0 || Boolean(run.webUnknownRequestId) || !["paused", "error"].includes(run.status)} onClick={() => void act(() => runtime({ type: "RESUME_RUN" }))}>▶ Tiếp tục</button></div>
    <button className="ghost" disabled={busy || unknownUsage.length > 0} onClick={() => { if (window.confirm("Chỉ tiếp tục nếu bạn đã kiểm tra yêu cầu AI cũ. Thử lại có thể gửi trùng. Xác nhận xử lý checkpoint đã biết?")) void act(() => runtime({ type: "CLEAR_REQUEST_CHECKPOINT" }), "Đã xác nhận xử lý yêu cầu AI cũ."); }}>Xác nhận xử lý yêu cầu AI cũ</button>
    <div className="safety">🛡 {run.practiceAutomation?.autoSubmit ? "Chỉ tự nộp bài được xác định là Luyện tập; Bài kiểm tra/Thi luôn bị chặn." : "Extension đang dừng trước nút “Nộp bài và kết thúc”."}</div>
  </section>;
}

function ManualRequest({ run, busy, act }: { run: RunSession; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [response, setResponse] = useState("");
  const [imagesAttached, setImagesAttached] = useState(false);
  const [newChatConfirmed, setNewChatConfirmed] = useState(false);
  const pending = run.pendingDecision!;
  const prompt = pending.decision.manualPrompt ?? "";
  useEffect(() => { setResponse(""); setImagesAttached(false); setNewChatConfirmed(false); }, [pending.decision.manualRequestId]);
  return <div className="panel-card form-grid"><b>AI Web — thao tác thủ công</b><small>Sao chép nội dung, gửi trong tab AI đã chọn, rồi dán đầy đủ JSON trả lời vào đây. Extension không điều khiển trang AI.</small>{pending.decision.manualRequiresNewChat && <label><input type="checkbox" checked={newChatConfirmed} onChange={(event) => setNewChatConfirmed(event.target.checked)} /> Tôi đã tạo chat mới trước khi gửi câu này.</label>}<label>Nội dung gửi<textarea readOnly rows={8} value={prompt} /></label><button className="secondary" disabled={pending.decision.manualRequiresNewChat && !newChatConfirmed} onClick={() => void act(() => navigator.clipboard.writeText(prompt), "Đã sao chép nội dung.")}>Sao chép nội dung</button>{pending.question.images.length > 0 && <label><input type="checkbox" checked={imagesAttached} onChange={(event) => setImagesAttached(event.target.checked)} /> Tôi đã đính kèm đủ {pending.question.images.length} ảnh câu hỏi vào AI.</label>}<label>Phản hồi JSON<textarea rows={7} value={response} onChange={(event) => setResponse(event.target.value)} /></label><button className="primary" disabled={busy || !response.trim()} onClick={() => void act(() => runtime({ type: "SUBMIT_MANUAL_RESPONSE", runId: run.id, questionId: pending.question.id, requestId: pending.decision.manualRequestId!, response, imagesAttached, newChatConfirmed }), "Đã kiểm tra phản hồi.")}>Kiểm tra phản hồi</button></div>;
}

function KnowledgePanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [courseId, setCourseId] = useState("");
  const [query, setQuery] = useState("");
  const [useGemini, setUseGemini] = useState(true);
  const [result, setResult] = useState<KnowledgeSearchResponse>();
  const course = state.courseIndex?.courses.find((item) => item.id === courseId);
  const summary = state.knowledgeIndexes.find((item) => item.courseId === courseId);
  const materials = course?.weeks.flatMap((week) => week.materials ?? []) ?? [];
  useEffect(() => {
    if (!courseId && state.courseIndex?.courses[0]) setCourseId(state.courseIndex.courses[0].id);
  }, [courseId, state.courseIndex]);
  useEffect(() => setResult(undefined), [courseId]);
  const kind = (value: string) => value === "slide" ? "Slide" : value === "textbook" ? "Giáo trình" : value === "lecture" ? "Bài giảng" : "Tài liệu";
  const index = () => act(() => runtime({ type: "INDEX_COURSE_MATERIALS", courseId }), "Đã lập chỉ mục tài liệu môn học.");
  const search = () => act(async () => {
    const data = await runtime<KnowledgeSearchResponse>({ type: "SEARCH_KNOWLEDGE", courseId, query, useGemini });
    setResult(data);
  });
  return <section><div className="section-head"><div><h2>Kho tài liệu môn học</h2><p>Tìm xuyên suốt slide và giáo trình theo từng tuần</p></div></div>
    {!state.courseIndex?.courses.length ? <Empty icon="⌕" title="Chưa có dữ liệu khóa học" text="Vào tab Khóa học và bấm Quét lại trước." /> : <>
      <div className="panel-card form-grid"><label>Khóa học<select value={courseId} onChange={(event) => setCourseId(event.target.value)}>{state.courseIndex.courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="knowledge-stats"><div><b>{materials.length}</b><small>Tài liệu nhận diện</small></div><div><b>{summary?.chunkCount ?? 0}</b><small>Đoạn đã lập chỉ mục</small></div><div><b>{summary?.failedCount ?? 0}</b><small>Tệp cần kiểm tra</small></div></div>
        {summary && <small className="indexed-at">Cập nhật {new Date(summary.indexedAt).toLocaleString("vi-VN")}</small>}
        <button className="primary" disabled={busy || !courseId || !materials.length} onClick={() => void index()}>{busy ? "Đang đọc tài liệu…" : summary ? "↻ Cập nhật chỉ mục" : "Lập chỉ mục tài liệu"}</button>
        {summary && <button className="ghost danger-text" disabled={busy} onClick={() => void act(() => runtime({ type: "CLEAR_KNOWLEDGE_INDEX", courseId }), "Đã xóa chỉ mục môn học.")}>Xóa chỉ mục môn này</button>}
      </div>
      <div className="material-list">{course?.weeks.filter((week) => (week.materials?.length ?? 0) > 0).map((week) => <details key={week.id}><summary><span>{week.name}</span><b>{week.materials.length}</b></summary>{week.materials.map((material) => <a key={material.id} href={material.url} target="_blank" rel="noreferrer"><i className={`material-kind ${material.kind}`}>{kind(material.kind)}</i><span>{material.name}</span><b>↗</b></a>)}</details>)}</div>
      <div className="panel-card knowledge-search form-grid"><label>Hỏi hoặc tìm trong toàn môn<textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ví dụ: Mô hình cửa sổ Johari gồm những phần nào?" /></label><Toggle label="Nhờ Gemini tổng hợp kèm nguồn" value={useGemini} onChange={setUseGemini} /><button className="primary" disabled={busy || !summary || !query.trim() || (useGemini && (!state.apiKeyPresent || !(state.settings.customModel || state.settings.model)))} onClick={() => void search()}>{useGemini ? "✦ Hỏi từ tài liệu" : "⌕ Tìm đoạn liên quan"}</button>{useGemini && (!state.apiKeyPresent || !(state.settings.customModel || state.settings.model)) && <small className="warn">Hãy lưu API key và chọn model ở tab Gemini, hoặc tắt chế độ tổng hợp.</small>}</div>
      {result && <article className={`knowledge-result ${result.insufficientEvidence ? "insufficient" : ""}`}><div className="result-head"><b>{result.usedGemini ? "✦ Gemini tổng hợp" : "⌕ Kết quả tìm kiếm"}</b>{result.insufficientEvidence && <span>Chưa đủ nguồn</span>}</div><p>{result.answer}</p><div className="citations">{result.citations.map((citation, index) => <a key={citation.chunkId} href={citation.materialUrl} target="_blank" rel="noreferrer"><b>[{citation.sourceNumber ?? index + 1}] {citation.materialName}</b><small>{citation.week}{citation.page ? ` · Trang ${citation.page}` : ""}</small><p>{citation.excerpt}</p></a>)}</div></article>}
    </>}
  </section>;
}

function GeminiPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [modelError, setModelError] = useState("");
  const loadVersion = useRef(0);
  useEffect(() => () => { loadVersion.current++; }, []);
  const loadModels = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const next = await runtime<GeminiModel[]>({ type: "LIST_MODELS" });
      if (version === loadVersion.current) { setModels(next); setModelError(""); }
      return next;
    } catch (error) {
      if (version === loadVersion.current) setModelError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, []);
  useEffect(() => {
    if (!state.apiKeyPresent) { loadVersion.current++; setModels([]); return; }
    void loadModels().catch(() => undefined);
  }, [state.apiKeyPresent, loadModels]);
  const currentModel = selectedModel(state.settings);
  const available = models.some((model) => model.id === currentModel);
  const canSwitch = canChangeSelection(state.run);
  return <section><div className="section-head"><div><h2>AI provider</h2><p>Chọn Gemini API hoặc kiểm tra trạng thái tab AI Web.</p></div></div>
    <div className="panel-card form-grid"><b>AI Web tự động</b><p><strong>ChatGPT Web — READY.</strong> Gửi prompt và đọc phản hồi trong tab đã bind.</p><p><strong>Claude Web — READY khi đã đăng nhập.</strong> Kiểm tra editor trước khi chạy.</p><p><strong>Gemini Web — READY.</strong> Dùng tab Gemini đã đăng nhập và chỉ nhận phản hồi mới của request hiện tại.</p><p><strong>DeepSeek Web — READY khi đã đăng nhập.</strong> Hỗ trợ textarea, phản hồi streaming, ảnh và tạo chat mới.</p><small>Không cần API key cho các tab Web. Nếu provider đổi giao diện, Kiểm tra liên kết sẽ báo selector nào không còn sẵn sàng.</small></div>
    <div className="section-head"><div><h3>Gemini API</h3><p className={state.apiKeyPresent ? "ok" : "warn"}>{state.apiKeyPresent ? "● API key đã lưu" : "● Chưa có API key"}</p></div></div>
    <div className="panel-card form-grid"><label>Gemini API key<div className="input-action"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={state.apiKeyPresent ? "••••••••••••••••" : "Dán API key"} autoComplete="off" /><button disabled={!key.trim() || busy || !canSwitch} onClick={() => void act(async () => { await changeApiCredential("gemini_api", key); await loadModels(); setKey(""); }, "Đã lưu key và tải danh sách model.")}>Lưu</button></div></label><div className="inline-actions"><button className="secondary" disabled={!state.apiKeyPresent || busy} onClick={() => void act(async () => { const result = await runtime<{ modelCount: number }>({ type: "VALIDATE_API_KEY" }); if (!result.modelCount) throw new Error("Key hợp lệ nhưng không có model tạo nội dung."); await loadModels(); }, "API key hoạt động.")}>Kiểm tra key</button><button className="ghost danger-text" disabled={!state.apiKeyPresent || busy || !canSwitch} onClick={() => void act(() => changeApiCredential("gemini_api"), "Đã xóa API key.")}>Xóa key</button></div></div>
    <div className="panel-card form-grid"><div className="field-head"><b>Model hỗ trợ generateContent</b><button className="link" disabled={!state.apiKeyPresent || busy} onClick={() => void act(loadModels, "Đã làm mới danh sách model.")}>↻ Làm mới</button></div>{modelError && <div className="error-box">{modelError}</div>}<label>Model Gemini API<select value={currentModel} disabled={busy || !state.apiKeyPresent || !canSwitch} onChange={(event) => { if (event.target.value) void act(() => runtime({ type: "SELECT_GEMINI_MODEL", model: event.target.value }), "Đã lưu model Gemini API."); }}><option value="">Chọn model</option>{currentModel && !available && <option value={currentModel}>{currentModel} — chưa xác minh trong danh sách</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.displayName} — {model.id}</option>)}</select></label>{!canSwitch && <small>Hãy dừng phiên trước khi đổi model.</small>}<small>Danh sách do Gemini API cung cấp; model của các trang AI Web được chọn trực tiếp trên trang đó.</small></div>
    <CapabilityTest provider="gemini_api" model={currentModel} capabilities={state.modelCapabilities} configured={state.apiKeyPresent} available={available} enabled={state.apiKeyPresent && canSwitch} busy={busy} act={act} />
    <div className="warning-card">Gemini API key được lưu cục bộ và không được gửi cho trang TNU. chrome.storage.local không phải kho bí mật được mã hóa. API có thể phát sinh phí và cần tài khoản API riêng.</div>
  </section>;
}

function OtherApiPanel({ provider, title, state, busy, act }: { provider: "openai_api" | "anthropic_api"; title: string; state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [modelError, setModelError] = useState("");
  const loadVersion = useRef(0);
  const present = state.providerKeys[provider];
  const canSwitch = canChangeSelection(state.run);
  const model = selectedProviderModel(state.settings, provider);
  const loadModels = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const list = await runtime<GeminiModel[]>({ type: "LIST_PROVIDER_MODELS", provider });
      if (version === loadVersion.current) { setModels(list); setModelError(""); }
    } catch (error) {
      if (version === loadVersion.current) setModelError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [provider]);
  useEffect(() => { if (present) void loadModels().catch(() => undefined); else { loadVersion.current++; setModels([]); } return () => { loadVersion.current++; }; }, [present, loadModels]);
  return <div className="panel-card form-grid">
    <div className="field-head"><b>{title}</b><small className={present ? "ok" : "warn"}>{present ? "Đã lưu key" : "Chưa có key"}</small></div>
    <label>API key<div className="input-action"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={present ? "••••••••••••••••" : "Dán API key"} autoComplete="off" /><button disabled={busy || !canSwitch || !key.trim()} onClick={() => void act(async () => { await changeApiCredential(provider, key); setKey(""); await loadModels(); }, "Đã lưu key và tải model.")}>Lưu</button></div></label>
    <div className="inline-actions"><button className="secondary" disabled={busy || !present} onClick={() => void act(loadModels, "Đã tải danh sách model.")}>Kiểm tra / làm mới model</button><button className="ghost danger-text" disabled={busy || !canSwitch || !present} onClick={() => void act(() => changeApiCredential(provider), "Đã xóa API key.")}>Xóa key</button></div>
    {modelError && <div className="error-box">{modelError}</div>}
    <label>Model<select value={model} disabled={busy || !present || !canSwitch} onChange={(event) => { if (event.target.value) void act(() => runtime({ type: "SELECT_PROVIDER_MODEL", provider, model: event.target.value }), "Đã lưu model."); }}><option value="">Chọn model</option>{model && !models.some((item) => item.id === model) && <option value={model}>{model} — chưa xác minh</option>}{models.map((item) => <option key={item.id} value={item.id}>{item.displayName} — {item.id}</option>)}</select></label>
    <small>Danh sách lấy từ API của nhà cung cấp; không phải mọi model đều hỗ trợ trả lời hoặc xử lý ảnh. Mỗi câu hỏi là một yêu cầu độc lập.</small>
    <CapabilityTest provider={provider} model={model} capabilities={state.modelCapabilities} configured={present} available={models.some((item) => item.id === model)} enabled={present && canSwitch} busy={busy} act={act} />
  </div>;
}

function verificationStatus(verifiedAt?: string, failedAt?: string): string {
  const verified = verifiedAt ? Date.parse(verifiedAt) : NaN;
  const failed = failedAt ? Date.parse(failedAt) : NaN;
  if (Number.isFinite(failed) && (!Number.isFinite(verified) || failed > verified)) return "xác minh thất bại lần gần nhất";
  if (!Number.isFinite(verified)) return "chưa xác minh thực tế";
  if (Date.now() - verified > 30 * 86400000) return "đã hết hạn (30 ngày)";
  return `đã xác minh ${new Date(verified).toLocaleDateString("vi-VN")}`;
}

function CapabilityTest({ provider, model, capabilities, configured, available, enabled, busy, act }: { provider: "gemini_api" | "openai_api" | "anthropic_api"; model: string; capabilities: AppState["modelCapabilities"]; configured: boolean; available: boolean; enabled: boolean; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [result, setResult] = useState("");
  useEffect(() => setResult(""), [model, provider]);
  const test = (image: boolean) => act(async () => {
    const data = await runtime<{ model: string; image: boolean; schemaValid: boolean; answerMatchesFixture: boolean; usage?: { totalTokens: number } }>({ type: "TEST_API_CAPABILITY", provider, image });
    setResult(`${data.model}: ${image ? "ảnh" : "văn bản"} · phản hồi hợp lệ${data.answerMatchesFixture ? ", đáp án mẫu đúng" : ", đáp án mẫu sai"}${data.usage ? ` · ${data.usage.totalTokens} token` : " · không có số liệu token"}.`);
  });
  const verified = capabilities.find((item) => item.provider === provider && item.model === model);
  return <div className="form-grid"><small>API: {configured ? "đã cấu hình" : "chưa cấu hình"} · model: {available ? "có trong danh sách API" : model ? "không có trong danh sách hiện tại" : "chưa chọn"}.</small><div className="inline-actions"><button className="secondary" disabled={busy || !enabled || !model} onClick={() => void test(false)}>Thử text thật</button><button className="secondary" disabled={busy || !enabled || !model} onClick={() => void test(true)}>Thử ảnh thật</button></div><small>Text: {verificationStatus(verified?.textVerifiedAt, verified?.textFailedAt)} · ảnh: {verificationStatus(verified?.imageVerifiedAt, verified?.imageFailedAt)}{provider === "openai_api" ? ` · Structured Outputs: ${verificationStatus(verified?.structuredVerifiedAt, verified?.structuredFailedAt)}` : ""}.</small><small>Chỉ lần bấm “Thử text/ảnh thật” gửi request trực tiếp tới API; model chỉ có trong danh sách hoặc mock test chưa được coi là đã kiểm chứng. Mỗi lần thử thật có thể phát sinh phí.</small>{result && <small>{result}</small>}</div>;
}

function SettingsPanel({ state, busy, act }: { state: AppState; busy: boolean; act: (fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const source = state.settings;
  const [settings, setSettings] = useState(source);
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { if (!dirty) setSettings(source); }, [source, dirty]);
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { setDirty(true); setSettings((current) => ({ ...current, [key]: value })); };
  const primaryProviders = PROVIDERS.filter((provider) => provider.primary);
  const legacyProvider = PROVIDERS.find((provider) => provider.id === state.settings.provider && !provider.primary);
  return <section><h2>Cài đặt</h2><div className="panel-card form-grid">
    <label>AI provider<select value={state.settings.provider} disabled={busy || !canChangeSelection(state.run)} onChange={(event) => void act(() => runtime({ type: "SWITCH_PROVIDER", provider: event.target.value as AppSettings["provider"] }), "Đã đổi provider. Phiên mới sẽ dùng lựa chọn này.")}>{legacyProvider && <option value={legacyProvider.id} disabled>{legacyProvider.label} — cấu hình cũ được giữ, chọn provider V3 để tiếp tục</option>}{primaryProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>{legacyProvider && <small className="warn">Provider cũ vẫn được lưu để bảo toàn thiết lập. OpenAI/Claude API và chế độ copy/paste Web không còn là luồng chính.</small>}{!canChangeSelection(state.run) && <small>Hãy dừng phiên trước khi đổi AI hoặc model.</small>}
    <label>Prompt cho Web adapter<textarea rows={5} value={settings.manualPrompt} onChange={(event) => set("manualPrompt", event.target.value)} /></label><small className="setting-help">Prompt này được ghép với câu hỏi, option ID, cache và tài liệu đã chọn rồi gửi tới tab AI Web đang bind.</small><button type="button" className="secondary" onClick={() => set("manualPrompt", DEFAULT_SETTINGS.manualPrompt)}>Khôi phục prompt Web mặc định</button>
    <label>Prompt cho Gemini API<textarea rows={5} value={settings.apiPrompt} onChange={(event) => set("apiPrompt", event.target.value)} /></label><small className="setting-help">Áp dụng cho Gemini API. Nội dung câu hỏi, ảnh, tài liệu và cache đã chọn được thêm theo cấu hình phiên.</small><button type="button" className="secondary" onClick={() => set("apiPrompt", DEFAULT_SETTINGS.apiPrompt)}>Khôi phục prompt API mặc định</button>
    <Toggle label="OpenAI Structured Outputs (model có hỗ trợ)" value={settings.openaiStructuredOutputs} onChange={(value) => set("openaiStructuredOutputs", value)} /><small className="setting-help">Chỉ bật nếu model hỗ trợ JSON Schema; hãy thử lại model sau khi thay đổi. Kết quả vẫn được kiểm tra trước khi điền.</small>
    <small className="setting-help">Biến tùy chọn: {"{question}"}, {"{options}"}, {"{question_type}"}, {"{documents}"}, {"{answer_cache}"}. Dữ liệu bắt buộc vẫn được thêm vào cuối. Đổi AI/model sau khi dừng có hiệu lực khi tiếp tục phiên.</small>
    <label>Chế độ cache<select value={settings.cacheMode} onChange={(event) => set("cacheMode", event.target.value as AppSettings["cacheMode"])}><option value="priority">Ưu tiên cache đã xác nhận</option><option value="ai">Gửi cache liên quan để AI đối chiếu</option><option value="independent">AI độc lập — không gửi cache</option></select></label>
    <label>Số đoạn tài liệu tối đa (1–20)<input type="number" min="1" max="20" value={settings.documentLimit} onChange={(event) => set("documentLimit", Number(event.target.value))} /></label>
    <label>Tạo chat Web mới sau số câu (0 = tắt)<input type="number" min="0" max="100" value={settings.manualRotationEvery} onChange={(event) => set("manualRotationEvery", Number(event.target.value))} /></label>
    <label>Ngưỡng tin cậy <b>{Math.round(settings.confidenceThreshold * 100)}%</b><input type="range" min="0.5" max="0.98" step="0.01" value={settings.confidenceThreshold} onChange={(event) => set("confidenceThreshold", Number(event.target.value))} /></label>
    <div className="panel-card form-grid full-score-settings"><b>🎯 Tự động đạt điểm tối đa</b><Toggle label="Bật chế độ Full điểm cho bài luyện tập" value={settings.practiceFullScoreEnabled} onChange={(value) => set("practiceFullScoreEnabled", value)} />{settings.practiceFullScoreEnabled && <><Toggle label="Tự động nộp bài luyện tập" value={settings.practiceAutoSubmit} onChange={(value) => set("practiceAutoSubmit", value)} /><Toggle label="Đã đủ điểm vẫn chạy để lấy cache" value={settings.practiceCollectCacheWhenFull} onChange={(value) => set("practiceCollectCacheWhenFull", value)} /><label>Số lần làm tối đa (1–20)<input type="number" min="1" max="20" value={settings.practiceMaxAttempts} onChange={(event) => set("practiceMaxAttempts", Number(event.target.value))} /></label><label>Số lần thử lại AI Web / câu (0–5)<input type="number" min="0" max="5" value={settings.webAutoRetryCount} onChange={(event) => set("webAutoRetryCount", Number(event.target.value))} /></label><small className="setting-help">Bật lấy cache nếu bạn muốn chạy lại bài đã 10/10. Extension sẽ làm lại, đọc trang kết quả để lưu cache rồi dừng khi đạt đủ điểm. Bài kiểm tra và bài thi không bao giờ được tự nộp.</small></>}</div>
    <div className="panel-card form-grid"><b>Thời gian chờ phản hồi</b><div className="two-col"><label>Timeout API (giây)<input type="number" min="5" max="120" value={settings.timeoutMs / 1000} onChange={(event) => set("timeoutMs", Number(event.target.value) * 1000)} /></label><label>Timeout AI Web (giây)<input type="number" min="30" max="1800" value={settings.webTimeoutMs / 1000} onChange={(event) => set("webTimeoutMs", Number(event.target.value) * 1000)} /></label></div><small className="setting-help">AI Web mặc định chờ 300 giây. Có thể đặt tối đa 1800 giây; giá trị mới được áp dụng khi Resume hoặc Thử lại.</small></div>
    <div className="two-col"><label>Số lần thử lại API<input type="number" min="0" max="5" value={settings.retryCount} onChange={(event) => set("retryCount", Number(event.target.value))} /></label></div>
    <small className="setting-help">Chỉ thử lại tự động khi API từ chối rõ ràng vì giới hạn tốc độ; yêu cầu không rõ trạng thái sẽ dừng. API dùng yêu cầu độc lập nên không cần tạo chat mới theo số câu.</small>
    <div className="two-col"><label>Giới hạn yêu cầu API / phiên (0 = tắt)<input type="number" min="0" max="100000" value={settings.maxRequests} onChange={(event) => set("maxRequests", Number(event.target.value))} /></label><label>Giới hạn token / phiên (0 = tắt)<input type="number" min="0" max="1000000000" value={settings.maxTokens} onChange={(event) => set("maxTokens", Number(event.target.value))} /></label></div>
    <label>Ngưỡng chi phí ước tính USD / phiên (0 = tắt)<input type="number" min="0" step="0.01" value={settings.maxCostUsd} onChange={(event) => set("maxCostUsd", Number(event.target.value))} /></label>
    <label>Khi không ước lượng được<select value={settings.unknownUsagePolicy} onChange={(event) => set("unknownUsagePolicy", event.target.value as AppSettings["unknownUsagePolicy"])}><option value="stop">Dừng an toàn trước khi gửi</option><option value="warn_and_continue">Cảnh báo và tiếp tục</option></select></label>
    <small className="setting-help">Trước khi gửi, extension tạm giữ dự toán đầu vào, ảnh, giới hạn đầu ra và giá model trong cùng một giao dịch trạng thái. Retry và fallback đều tính là lượt API riêng. Khi không nhận được usage, mặc định sẽ dừng an toàn; có thể chọn tiếp tục khi chấp nhận thiếu ước lượng. Dự toán chỉ là giới hạn nội bộ, không thay thế hard spending limit của nhà cung cấp.</small>
    <PriceEditor settings={settings} onChange={(prices) => set("modelPrices", prices)} />
    <Toggle label="Cho phép chuyển sang API dự phòng" value={settings.fallbackEnabled} onChange={(value) => set("fallbackEnabled", value)} />
    {settings.fallbackEnabled && <><label>Thứ tự API dự phòng<select value={settings.fallbackOrder.join(",")} onChange={(event) => set("fallbackOrder", event.target.value.split(",") as AppSettings["fallbackOrder"])}>{[["gemini_api", "openai_api", "anthropic_api"], ["gemini_api", "anthropic_api", "openai_api"], ["openai_api", "gemini_api", "anthropic_api"], ["openai_api", "anthropic_api", "gemini_api"], ["anthropic_api", "gemini_api", "openai_api"], ["anthropic_api", "openai_api", "gemini_api"]].map((order) => <option key={order.join(",")} value={order.join(",")}>{order.map((id) => PROVIDERS.find((item) => item.id === id)?.label).join(" → ")}</option>)}</select></label><label>Số provider dự phòng tối đa<input type="number" min="0" max="2" value={settings.fallbackMax} onChange={(event) => set("fallbackMax", Number(event.target.value))} /></label><small className="setting-help">Chuyển sau khi đã hết retry nếu mã lỗi xác nhận giới hạn tốc độ tạm thời hoặc quá tải. Lỗi quota ngày, tín dụng, billing, spending limit và 429 không rõ mã sẽ không retry/fallback. Model dự phòng cần còn khả dụng và có xác minh text/ảnh còn hạn; ngân sách được kiểm tra lại trước khi dispatch.</small></>}
    <label>Khoảng nghỉ giữa lần gửi AI (giây)<input type="number" min="0" max="60" step="0.05" value={settings.delayMs / 1000} onChange={(event) => set("delayMs", Math.round(Number(event.target.value) * 1000))} /></label>
    <label>Từ khóa luyện tập<textarea value={settings.practiceKeywords.join(", ")} onChange={(event) => set("practiceKeywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>
    <label>Từ khóa kiểm tra<textarea value={settings.gradedKeywords.join(", ")} onChange={(event) => set("gradedKeywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>
    <Toggle label="Tự chuyển trang" value={settings.autoNavigate} onChange={(value) => set("autoNavigate", value)} />
    <Toggle label="Thông báo hệ thống" value={settings.notificationsEnabled} onChange={(value) => set("notificationsEnabled", value)} />
    <Toggle label="Âm thanh" value={settings.soundEnabled} onChange={(value) => set("soundEnabled", value)} />
    <Toggle label="Hiện giải thích AI" value={settings.showReason} onChange={(value) => set("showReason", value)} />
    <Toggle label="Mặc định chọn tất cả tài liệu đã lập chỉ mục khi chuẩn bị" value={settings.useCourseKnowledgeForAnswers} onChange={(value) => set("useCourseKnowledgeForAnswers", value)} />
    <small className="setting-help">Bạn vẫn có thể chọn hoặc bỏ từng tài liệu trước mỗi lần chạy. Chỉ tài liệu được đính kèm ở bước chuẩn bị mới được đưa cho AI.</small>
    <label>Khi AI phân vân<select value={settings.uncertainMode} onChange={(event) => set("uncertainMode", event.target.value as AppSettings["uncertainMode"])}><option value="reason">Tự suy luận lại một lần</option><option value="ask">Dừng và hỏi tôi</option></select></label>
    {settings.soundEnabled && <label>Âm lượng <b>{Math.round(settings.volume * 100)}%</b><input type="range" min="0.05" max="1" step="0.05" value={settings.volume} onChange={(event) => set("volume", Number(event.target.value))} /></label>}
    <button className="primary" disabled={busy || settings.modelPrices.some((price) => !isValidModelPrice(price))} onClick={() => void act(async () => { await runtime({ type: "SAVE_SETTINGS", settings }); setDirty(false); }, "Đã lưu cài đặt.")}>Lưu cài đặt</button>
  </div><div className="panel-card memory-card"><div><span>✓</span><p><b>Bộ nhớ đáp án đúng</b><small>{state.answerMemoryCount} câu đã học từ trang xem lại sau chấm bài</small></p></div><button className="ghost danger-text" disabled={busy || !state.answerMemoryCount} onClick={() => void act(() => runtime({ type: "CLEAR_ANSWER_MEMORY" }), "Đã xóa bộ nhớ đáp án.")}>Xóa bộ nhớ</button></div>
  <div className="panel-card data-card"><div className="field-head"><b>Quyền riêng tư và dung lượng</b><small>Đang dùng {formatBytes(state.storageBytes)}</small></div><p>Xóa API key khi không sử dụng, hoặc reset toàn bộ để xóa cài đặt, khóa học, hàng đợi, nhật ký, phiên chạy và bộ nhớ đáp án.</p><div className="data-actions"><button className="secondary danger-text" disabled={busy || !state.apiKeyPresent || !canChangeSelection(state.run)} onClick={() => void act(() => changeApiCredential("gemini_api"), "Đã xóa API key khỏi máy.")}>Xóa API key</button><button className={confirmReset ? "stop confirm" : "ghost danger-text"} disabled={busy} onClick={() => { if (!confirmReset) { setConfirmReset(true); window.setTimeout(() => setConfirmReset(false), 5000); return; } void act(async () => { await runtime({ type: "CLEAR_ALL_DATA" }); setConfirmReset(false); }, "Đã reset toàn bộ dữ liệu extension."); }}>{confirmReset ? "Xác nhận reset toàn bộ" : "Reset toàn bộ"}</button></div>{confirmReset && <small className="reset-warning">Bấm lại trong 5 giây để xác nhận. Thao tác này không thể hoàn tác.</small>}</div></section>;
}

function PriceEditor({ settings, onChange }: { settings: AppSettings; onChange: (prices: AppSettings["modelPrices"]) => void }) {
  const sources = { gemini_api: "https://ai.google.dev/gemini-api/docs/pricing", openai_api: "https://developers.openai.com/api/docs/pricing", anthropic_api: "https://platform.claude.com/docs/en/about-claude/pricing" };
  const providers = ["gemini_api", "openai_api", "anthropic_api"] as const;
  const update = (index: number, patch: Partial<AppSettings["modelPrices"][number]>) => onChange(settings.modelPrices.map((price, i) => i === index ? { ...price, ...patch } : price));
  return <div className="panel-card form-grid"><b>Giá do bạn đối chiếu (USD / 1 triệu token)</b><small>Nhập giá từ trang chính thức phù hợp model, tài khoản và loại sử dụng. Giá có thể khác theo ảnh, cache, bậc giá hoặc gói; extension không tự kiểm chứng và không bảo đảm chi phí thực.</small>
    <div className="inline-actions">{providers.map((provider) => { const model = selectedProviderModel(settings, provider); return <button type="button" key={provider} disabled={!model || settings.modelPrices.some((item) => item.provider === provider && item.model === model)} onClick={() => onChange([...settings.modelPrices, { provider, model, inputUsdPerMillion: -1, outputUsdPerMillion: -1, sourceUrl: sources[provider], checkedOn: "" }])}>Thêm giá {PROVIDERS.find((item) => item.id === provider)?.label}</button>; })}</div>
    {settings.modelPrices.map((price, index) => <div className="form-grid" key={`${price.provider}:${price.model}`}><b>{price.provider} · {price.model}</b><div className="two-col"><label>Đầu vào<input type="number" min="0" step="any" value={price.inputUsdPerMillion < 0 ? "" : price.inputUsdPerMillion} onChange={(event) => update(index, { inputUsdPerMillion: event.target.value === "" ? -1 : Number(event.target.value) })} /></label><label>Đầu ra<input type="number" min="0" step="any" value={price.outputUsdPerMillion < 0 ? "" : price.outputUsdPerMillion} onChange={(event) => update(index, { outputUsdPerMillion: event.target.value === "" ? -1 : Number(event.target.value) })} /></label></div><label>Ngày bạn đối chiếu<input type="date" value={price.checkedOn} onChange={(event) => update(index, { checkedOn: event.target.value })} /></label><label>Trang giá chính thức<input value={price.sourceUrl} onChange={(event) => update(index, { sourceUrl: event.target.value })} /></label><button type="button" className="ghost danger-text" onClick={() => onChange(settings.modelPrices.filter((_, i) => i !== index))}>Xóa giá</button>{!isValidModelPrice(price) && <small className="warn">Điền đủ giá, ngày và trang chính thức trước khi lưu.</small>}</div>)}
  </div>;
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
