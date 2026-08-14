// Worker Interface（spec §15）— Control Plane 內部抽象。
// Control Plane 不知道 Worker 是 Pi / OpenCode / stub——只透過此介面呼叫。
// 三層 protocol 分離：Worker Interface（內部）≠ ACP-Protocol（外部 runtime）≠ MCP（tools）。

import type { TaskRow } from "../task/types.js";

/**
 * Evidence Bundle（§13）— Worker 收到的證據集。
 * 已由 Control Plane shaping（§12.2）：facts 依 relevance×confidence 保留至預算。
 * Worker 不得自行 re-research——Research 是 Control Plane 的 policy-controlled capability（§16）。
 */
export interface WorkerEvidenceBundle {
  taskId: string;
  facts: Array<{
    id: string;
    claim: string;
    source: string;
    sourceType: string;
    confidence: number;
    relevance: number;
  }>;
  constraints: string[];
  versions: Array<{ package: string; version: string }>;
  unresolvedQuestions: string[];
  truncated: boolean;
  droppedFactIds: string[];
  estimatedTokens: number;
}

/** Plan — Control Plane 產生的實作計畫（T011/T019 之後由 planner 產生；現階段為最小雛形）。 */
export interface WorkerPlan {
  id: string;
  steps: Array<{ id: string; description: string }>;
}

/** Execution Policy（§15）— Worker 執行時的權限邊界。 */
export interface WorkerExecutionPolicy {
  strategy: string;
  tier: string;
  worker: string;
  model: string;
  allowCloud: boolean;
  maxAttempts: number;
  /** §16 contract：允許修改的檔案（glob）。 */
  allowedFiles: string[];
  /** §16 contract：唯讀檔案（glob）。 */
  readonlyFiles: string[];
  /** §16 contract：驗證指令。 */
  verification: string[];
}

/** Workspace Context — 任務工作目錄與 repo 資訊。 */
export interface WorkerWorkspaceContext {
  path: string;
  languages: string[];
  frameworks: string[];
}

/** WorkerContext — initialize 時傳入的靜態環境。 */
export interface WorkerContext {
  /** llama.cpp OpenAI-compatible endpoint base URL（§16）。 */
  baseUrl: string;
  /** 模型名稱（不是 dependency，由 config 指定，§16）。 */
  model: string;
  workspaceRoot: string;
}

/** WorkerRequest（§15）— 一次執行的完整輸入。 */
export interface WorkerRequest {
  task: TaskRow;
  evidence: WorkerEvidenceBundle;
  plan: WorkerPlan;
  executionPolicy: WorkerExecutionPolicy;
  workspace: WorkerWorkspaceContext;
  /** T021 §16：上一輪驗證失敗的輸出（重試時回饋給 worker；首次執行為 undefined）。 */
  previousFeedback?: string;
}

/** WorkerResult — execute 的產出（patch + 摘要）。 */
export interface WorkerResult {
  ok: boolean;
  /** 產出的 patch（unified diff）或描述。 */
  patch?: string;
  /** 修改的檔案清單。 */
  changedFiles: string[];
  /** 給 Control Plane 的簡短摘要。 */
  summary: string;
  /** 失敗時的錯誤分類（配合 T020 Reflection）。 */
  errorClassification?: string;
  /** 原始輸出（供 reflection error-signature 掃描，§36.2）。 */
  output?: string;
  durationMs: number;
}

/** CodingWorker（§15）— 所有 Worker 實作此介面。 */
export interface CodingWorker {
  readonly id: string;
  initialize(context: WorkerContext): Promise<void>;
  execute(request: WorkerRequest): Promise<WorkerResult>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
}
