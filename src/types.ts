export type AssessmentKind = "practice" | "graded" | "unknown";
export type QuestionType = "single" | "multiple" | "truefalse" | "unsupported";
export type RunMode = "from_start" | "from_current";
export type UncertainMode = "reason" | "ask";
export type ApiProviderId = "gemini_api" | "openai_api" | "anthropic_api";
export type WebProviderId = "chatgpt_web" | "claude_web" | "gemini_web" | "deepseek_web";
export type LegacyManualProviderId = "chatgpt_manual" | "claude_manual" | "gemini_web_manual";
export type ProviderId = ApiProviderId | WebProviderId | LegacyManualProviderId;
export type CourseMaterialKind = "slide" | "textbook" | "lecture" | "other";
export type RunStatus =
  | "idle"
  | "scanning"
  | "preparing"
  | "answering"
  | "awaiting_user"
  | "navigating"
  | "paused"
  | "completed"
  | "error";

export interface QuestionOption {
  id: string;
  label: string;
  selected: boolean;
}

export interface QuestionImage {
  mimeType: string;
  data: string;
}

export interface QuestionSnapshot {
  id: string;
  number: string;
  type: QuestionType;
  prompt: string;
  options: QuestionOption[];
  images: QuestionImage[];
}

export interface AnswerDecision {
  selectedOptionIds: string[];
  confidence: number;
  reason: string;
  needsHumanReview: boolean;
  source?: "gemini" | "openai" | "anthropic" | "memory" | "manual";
  manualPrompt?: string;
  manualRequestId?: string;
  manualRequiresNewChat?: boolean;
  manualPrimary?: AnswerDecision;
  executionRequestId?: string;
  reasoningPass?: boolean;
  verification?: AnswerVerification;
}

export interface AnswerVerification {
  status: "agreed" | "conflict" | "uncertain" | "user_confirmed";
  primarySource: "gemini" | "openai" | "anthropic" | "memory" | "manual";
  primaryOptionIds: string[];
  primaryConfidence: number;
  verifierOptionIds: string[];
  verifierConfidence: number;
  verifierReason: string;
}

export interface AnswerMemoryEntry {
  id: string;
  quizKey: string;
  courseId: string;
  courseName?: string;
  week?: string;
  quizName?: string;
  questionFingerprint: string;
  prompt: string;
  questionType: QuestionType;
  correctOptionLabels: string[];
  learnedAt: string;
  sourceUrl: string;
}

export interface AnswerMemorySource {
  quizKey: string;
  courseId: string;
  courseName: string;
  week: string;
  quizName: string;
  answerCount: number;
  learnedAt: string;
}

export interface QuizTarget {
  id: string;
  url: string;
  courseId: string;
  courseName: string;
  category: string;
  week: string;
  name: string;
  assessmentKind: AssessmentKind;
  source: "auto" | "manual";
}

export interface CourseMaterial {
  id: string;
  courseId: string;
  courseName: string;
  week: string;
  name: string;
  url: string;
  kind: CourseMaterialKind;
}

export interface KnowledgeChunk {
  id: string;
  courseId: string;
  materialId: string;
  materialName: string;
  materialUrl: string;
  week: string;
  kind: CourseMaterialKind;
  page?: number;
  text: string;
}

export interface KnowledgeIndex {
  courseId: string;
  courseName: string;
  indexedAt: string;
  materials: CourseMaterial[];
  chunks: KnowledgeChunk[];
  failedMaterials: Array<{ materialId: string; name: string; reason: string }>;
}

export interface KnowledgeExtractionResult {
  chunks: KnowledgeChunk[];
  failedMaterials: Array<{ materialId: string; name: string; reason: string }>;
}

export interface KnowledgeIndexSummary {
  courseId: string;
  courseName: string;
  indexedAt: string;
  materialCount: number;
  chunkCount: number;
  failedCount: number;
  indexedMaterialIds: string[];
}

export interface KnowledgeCitation {
  chunkId: string;
  sourceNumber?: number;
  materialName: string;
  materialUrl: string;
  week: string;
  page?: number;
  excerpt: string;
}

export interface KnowledgeSearchResponse {
  answer: string;
  citations: KnowledgeCitation[];
  usedGemini: boolean;
  insufficientEvidence: boolean;
}

export interface CourseWeek {
  id: string;
  name: string;
  activities: QuizTarget[];
  materials: CourseMaterial[];
}

export interface CourseInfo {
  id: string;
  name: string;
  url: string;
  category: string;
  weeks: CourseWeek[];
}

export interface CourseIndex {
  courses: CourseInfo[];
  scannedAt: string;
  sourceUrl: string;
}

export interface PendingDecision {
  question: QuestionSnapshot;
  decision: AnswerDecision;
}

export interface RunSession {
  id: string;
  sessionId?: string;
  executionEpoch?: string;
  tnuWindowId?: number;
  aiTabId?: number;
  aiWindowId?: number;
  conversationIdentity?: string;
  webFixture?: boolean;
  webCompletedCount?: number;
  webUnknownRequestId?: string;
  webCompletedResponse?: { question: QuestionSnapshot; decision: AnswerDecision };
  activeExecution?: {
    requestId: string;
    executionEpoch: string;
    questionId: string;
    providerId: AppSettings["provider"];
    modelId: string;
    status: "waiting" | "dispatching" | "in_flight" | "completed" | "unknown";
  };
  usage?: RunUsage;
  lastError?: { provider: ApiProviderId; model: string; kind: string; status: number; providerCode?: string; at: string };
  tnuTabId?: number;
  provider?: AppSettings["provider"];
  settingsSnapshot?: AppSettings;
  manualConversationCount?: number;
  manualNewChatRequired?: boolean;
  dryRunLimit?: number;
  dryRunCount?: number;
  target: QuizTarget;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  page: number;
  currentQuestion: number;
  totalOnPage: number;
  processedQuestionIds: string[];
  startAnchorUsed: boolean;
  startAnchorPage?: number;
  startAnchorIndex?: number;
  memorySourceQuizKey?: string | null;
  memorySourceQuizKeys: string[];
  reviewEveryAnswer: boolean;
  knowledgeMaterialIds: string[];
  practiceBatch?: { targets: QuizTarget[]; currentIndex: number };
  pendingDecision?: PendingDecision;
  currentQuestionSnapshot?: QuestionSnapshot;
  message: string;
  error?: string;
}

export interface RunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unknownUsageRequests: number;
  fallbackCount: number;
  pending: Array<{ id: string; requestId?: string; questionId?: string; provider: ApiProviderId; model: string; status?: "reserved" | "dispatching" | "in_flight" | "unknown" | "estimated"; inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number }>;
  byModel: Array<{ provider: ApiProviderId; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }>;
}

export interface ModelPrice {
  provider: ApiProviderId;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  sourceUrl: string;
  checkedOn: string;
}

export interface ModelCapability {
  provider: ApiProviderId;
  model: string;
  textVerifiedAt?: string;
  textFailedAt?: string;
  imageVerifiedAt?: string;
  imageFailedAt?: string;
  structuredVerifiedAt?: string;
  structuredFailedAt?: string;
}

export interface AppSettings {
  schemaVersion: 10;
  provider: ProviderId;
  selectionRevision: string;
  manualPrompt: string;
  apiPrompt: string;
  openaiModel: string;
  anthropicModel: string;
  openaiStructuredOutputs: boolean;
  cacheMode: "priority" | "ai" | "independent";
  documentLimit: number;
  manualRotationEvery: number;
  model: string;
  customModel: string;
  uncertainMode: UncertainMode;
  confidenceThreshold: number;
  timeoutMs: number;
  webTimeoutMs: number;
  retryCount: number;
  maxRequests: number;
  maxTokens: number;
  maxCostUsd: number;
  unknownUsagePolicy: "stop" | "warn_and_continue";
  modelPrices: ModelPrice[];
  fallbackEnabled: boolean;
  fallbackOrder: ApiProviderId[];
  fallbackMax: number;
  delayMs: number;
  practiceKeywords: string[];
  gradedKeywords: string[];
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  volume: number;
  autoNavigate: boolean;
  showReason: boolean;
  useCourseKnowledgeForAnswers: boolean;
  scormEnabled: boolean;
  scormPlaybackRate: number;
  scormAutoNext: boolean;
  scormNextDelayMs: number;
  scormPauseOnInteraction: boolean;
}

export interface ScormStatus {
  tabId: number;
  frameUrl: string;
  detected: boolean;
  enabled: boolean;
  state: "idle" | "playing" | "paused" | "waiting" | "waiting_next" | "interaction" | "completed" | "error";
  playbackRate: number;
  mediaKind?: "audio" | "video";
  currentTime?: number;
  duration?: number;
  message: string;
  updatedAt: string;
}

export interface GeminiModel {
  id: string;
  displayName: string;
  description: string;
}

export interface AppState {
  settings: AppSettings;
  apiKeyPresent: boolean;
  providerKeys: { openai_api: boolean; anthropic_api: boolean };
  modelCapabilities: ModelCapability[];
  courseIndex?: CourseIndex;
  queue: QuizTarget[];
  run?: RunSession;
  logs: LogEntry[];
  answerMemoryCount: number;
  answerMemorySources: AnswerMemorySource[];
  knowledgeIndexes: KnowledgeIndexSummary[];
  storageBytes: number;
  browserTabs?: BrowserTabSummary[];
  webTabBinding?: WebTabBinding;
  scormStatus?: ScormStatus;
}

export interface BrowserTabSummary {
  id: number;
  windowId: number;
  title: string;
  url: string;
  domain: string;
  kind: "tnu" | "ai";
  providerId?: WebProviderId;
  integrationStatus: "ready" | "blocked" | "not_verified";
  fixture?: boolean;
}

export interface WebTabBinding {
  tnuTabId: number;
  tnuWindowId: number;
  aiTabId: number;
  aiWindowId: number;
  providerId: WebProviderId;
  fixture?: boolean;
  boundAt: string;
}

export interface LogEntry {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export type RuntimeMessage =
  | { type: "GET_STATE" }
  | { type: "LIST_WEB_TABS" }
  | { type: "BIND_WEB_TABS"; tnuTabId: number; aiTabId: number; providerId: WebProviderId }
  | { type: "CLEAR_WEB_TAB_BINDING" }
  | { type: "CHECK_WEB_TAB_BINDING" }
  | { type: "SAVE_SETTINGS"; settings: AppSettings }
  | { type: "SWITCH_PROVIDER"; provider: AppSettings["provider"] }
  | { type: "SELECT_GEMINI_MODEL"; model: string }
  | { type: "BEGIN_CREDENTIAL_CHANGE"; provider: ApiProviderId }
  | { type: "COMPLETE_CREDENTIAL_CHANGE"; provider: ApiProviderId; token: string }
  | { type: "CANCEL_CREDENTIAL_CHANGE"; token: string }
  | { type: "LIST_PROVIDER_MODELS"; provider: "openai_api" | "anthropic_api" }
  | { type: "SELECT_PROVIDER_MODEL"; provider: "openai_api" | "anthropic_api"; model: string }
  | { type: "TEST_API_CAPABILITY"; provider: ApiProviderId; image: boolean }
  | { type: "LIST_MODELS" }
  | { type: "VALIDATE_API_KEY" }
  | { type: "SCAN_COURSES" }
  | { type: "SAVE_QUEUE"; queue: QuizTarget[] }
  | { type: "START_RUN"; target: QuizTarget; mode: RunMode; memorySourceQuizKeys: string[]; reviewEveryAnswer: boolean; knowledgeMaterialIds: string[]; batchTargets?: QuizTarget[]; tnuTabId?: number; dryRunLimit?: number }
  | { type: "STOP_RUN" }
  | { type: "RESUME_RUN" }
  | { type: "RETRY_QUESTION" }
  | { type: "SKIP_QUESTION"; executionEpoch?: string }
  | { type: "APPLY_SUGGESTION"; executionEpoch?: string }
  | { type: "VERIFY_QUESTION" }
  | { type: "SUBMIT_MANUAL_RESPONSE"; runId: string; questionId: string; requestId: string; response: string; imagesAttached: boolean; newChatConfirmed: boolean }
  | { type: "MANUAL_NEW_CHAT"; runId: string }
  | { type: "RESOLVE_UNKNOWN_WEB"; requestId: string; resolution: "confirmed_no_reply" }
  | { type: "CREATE_WEB_CONVERSATION"; runId: string }
  | { type: "RESOLVE_UNKNOWN_USAGE"; requestId: string; resolution: "not_charged" | "count_estimate" }
  | { type: "CLEAR_REQUEST_CHECKPOINT" }
  | { type: "RESOLVE_UNKNOWN_USAGE"; requestId: string; resolution: "not_charged" | "count_estimate" }
  | { type: "CONFIRM_VERIFICATION"; choice: "primary" | "verifier" }
  | { type: "SHOW_VERIFICATION"; questionId: string; selectedOptionIds: string[]; executionEpoch?: string }
  | { type: "ANSWER_QUESTION"; runId: string; executionEpoch: string; question: QuestionSnapshot }
  | { type: "SAVE_REVIEW_ANSWERS"; runId?: string; executionEpoch?: string; target: QuizTarget; entries: AnswerMemoryEntry[]; sourceUrl: string; reviewComplete: boolean }
  | { type: "CLEAR_ANSWER_MEMORY" }
  | { type: "CLEAR_ALL_DATA" }
  | { type: "INDEX_COURSE_MATERIALS"; courseId: string }
  | { type: "EXTRACT_COURSE_MATERIALS"; materials: CourseMaterial[] }
  | { type: "SEARCH_KNOWLEDGE"; courseId: string; query: string; useGemini: boolean }
  | { type: "CLEAR_KNOWLEDGE_INDEX"; courseId: string }
  | { type: "UPDATE_RUN"; runId: string; executionEpoch?: string; patch: Partial<RunSession> }
  | { type: "NOTIFY"; title: string; message: string; level?: LogEntry["level"] }
  | { type: "SCORM_STATUS_UPDATE"; status: Omit<ScormStatus, "tabId"> }
  | { type: "SCORM_CONTROL"; settings: Pick<AppSettings, "scormEnabled" | "scormPlaybackRate" | "scormAutoNext" | "scormNextDelayMs" | "scormPauseOnInteraction"> }
  | { type: "SCORM_APPLY_SETTINGS"; settings: Pick<AppSettings, "scormEnabled" | "scormPlaybackRate" | "scormAutoNext" | "scormNextDelayMs" | "scormPauseOnInteraction"> }
  | { type: "CONTENT_READY"; url: string };

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
