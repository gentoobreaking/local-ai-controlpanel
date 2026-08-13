// Core Domain Model（spec §8）。

export type TaskStatus =
  | "CREATED"
  | "ANALYZING"
  | "POLICY_CHECK"
  | "RESEARCH_REQUIRED"
  | "RESEARCHING"
  | "EVIDENCE_VALIDATION"
  | "PLANNING"
  | "WORKER_SELECTION"
  | "IMPLEMENTING"
  | "ARTIFACT_VALIDATION"
  | "VERIFYING"
  | "COMPLETE"
  | "REFLECTION"
  | "ASK_USER"
  | "STOP"
  | "CANCELLED";

export type Complexity = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high";
export type SandboxMode = "auto" | "bwrap" | "seatbelt" | "shuru" | "docker";

export interface RepositoryContext {
  path: string;
  gitBranch: string;
  commit: string;
  languages: string[];
  detectedFrameworks: string[];
  detectedDependencies: string[];
}

/** DB row 對應（snake_case 欄位）。 */
export interface TaskRow {
  id: string;
  request: string;
  status: TaskStatus;
  complexity: Complexity | null;
  risk: RiskLevel | null;
  sandboxMode: SandboxMode | null;
  /** workspace 根目錄（建驗證用，§21.2）；未指定為 null */
  workspace: string | null;
  flags: string[];
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

/** API summary（§45.5 GET /tasks）。 */
export interface TaskSummary {
  id: string;
  userRequest: string;
  status: TaskStatus;
  attempt: number;
  sandboxMode?: SandboxMode;
  updatedAt: string;
}

/** API detail（§45.5 GET /tasks/:id）。 */
export interface TaskDetail extends TaskSummary {
  complexity?: Complexity;
  risk?: RiskLevel;
  flags?: string[];
  workspace?: string;
  createdAt: string;
  evidence?: {
    count: number;
    confidence?: number;
  };
  verification?: {
    verifier?: string;
    status?: string;
    sandbox?: string;
    durationMs?: number;
  };
}

export interface CreateTaskInput {
  userRequest: string;
  workspace?: string;
  sandboxMode?: SandboxMode;
  complexity?: Complexity;
  risk?: RiskLevel;
}