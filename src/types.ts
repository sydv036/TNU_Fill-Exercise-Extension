export type AssessmentKind = "practice" | "graded" | "unknown";
export type QuestionType = "single" | "multiple" | "truefalse" | "unsupported";
export type RunMode = "from_start" | "from_current";
export type UncertainMode = "reason" | "ask";
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
  source?: "gemini" | "memory";
  reasoningPass?: boolean;
}

export interface AnswerMemoryEntry {
  id: string;
  quizKey: string;
  courseId: string;
  questionFingerprint: string;
  prompt: string;
  questionType: QuestionType;
  correctOptionLabels: string[];
  learnedAt: string;
  sourceUrl: string;
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
  pendingDecision?: PendingDecision;
  currentQuestionSnapshot?: QuestionSnapshot;
  message: string;
  error?: string;
}

export interface AppSettings {
  schemaVersion: 3;
  model: string;
  customModel: string;
  uncertainMode: UncertainMode;
  confidenceThreshold: number;
  timeoutMs: number;
  retryCount: number;
  delayMs: number;
  practiceKeywords: string[];
  gradedKeywords: string[];
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  volume: number;
  autoNavigate: boolean;
  showReason: boolean;
  useCourseKnowledgeForAnswers: boolean;
}

export interface GeminiModel {
  id: string;
  displayName: string;
  description: string;
}

export interface AppState {
  settings: AppSettings;
  apiKeyPresent: boolean;
  courseIndex?: CourseIndex;
  queue: QuizTarget[];
  run?: RunSession;
  logs: LogEntry[];
  answerMemoryCount: number;
  knowledgeIndexes: KnowledgeIndexSummary[];
  storageBytes: number;
}

export interface LogEntry {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export type RuntimeMessage =
  | { type: "GET_STATE" }
  | { type: "SAVE_SETTINGS"; settings: AppSettings }
  | { type: "SAVE_API_KEY"; apiKey: string }
  | { type: "DELETE_API_KEY" }
  | { type: "LIST_MODELS" }
  | { type: "VALIDATE_API_KEY" }
  | { type: "SCAN_COURSES" }
  | { type: "SAVE_QUEUE"; queue: QuizTarget[] }
  | { type: "START_RUN"; target: QuizTarget; mode: RunMode }
  | { type: "STOP_RUN" }
  | { type: "RESUME_RUN" }
  | { type: "RETRY_QUESTION" }
  | { type: "SKIP_QUESTION" }
  | { type: "APPLY_SUGGESTION" }
  | { type: "ANSWER_QUESTION"; question: QuestionSnapshot }
  | { type: "SAVE_REVIEW_ANSWERS"; entries: AnswerMemoryEntry[] }
  | { type: "CLEAR_ANSWER_MEMORY" }
  | { type: "CLEAR_ALL_DATA" }
  | { type: "INDEX_COURSE_MATERIALS"; courseId: string }
  | { type: "EXTRACT_COURSE_MATERIALS"; materials: CourseMaterial[] }
  | { type: "SEARCH_KNOWLEDGE"; courseId: string; query: string; useGemini: boolean }
  | { type: "CLEAR_KNOWLEDGE_INDEX"; courseId: string }
  | { type: "UPDATE_RUN"; patch: Partial<RunSession> }
  | { type: "NOTIFY"; title: string; message: string; level?: LogEntry["level"] }
  | { type: "CONTENT_READY"; url: string };

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
