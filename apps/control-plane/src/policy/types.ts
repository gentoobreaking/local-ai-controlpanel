// Policy Engine 決策型別（spec §10 / §11 / §14 / §20 / §24 / §25）。
// 決策過程不含任何 LLM（§10 Rule 1）——全部是確定性規則。

export interface TaskAnalysis {
  languages: string[];
  frameworks: string[];
  dependencies: string[];
  complexity: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  researchRequired: boolean;
  researchReasons: string[];
}

export type TaskPolicyDecision =
  | { action: "REQUIRE_RESEARCH"; reasons: string[] }
  | { action: "ALLOW_PLANNING" };

export interface ArtifactDecision {
  verdict: "APPROVED" | "DENIED";
  violations: { file: string; rule: "forbidden" | "readonly" | "not_allowed" }[];
}

export type ToolKind =
  | "network"
  | "shell"
  | "filesystem_read"
  | "filesystem_write"
  | "git_read"
  | "git_write";

export interface ToolRequest {
  tool: ToolKind;
  description?: string;
}

export type ToolDecision =
  | { verdict: "ALLOW"; reason: string }
  | { verdict: "DENY"; reason: string }
  | { verdict: "ALLOW_IN_SANDBOX"; reason: string };

// §25 Execution Strategy：支援 Local / Hybrid / Cloud 三層
export type ExecutionTier = "local" | "hybrid" | "cloud";

export type EscalationMode =
  | "reviewer_first"  // H: Local 失敗 → Cloud Reviewer 審查 patch → Local 重做
  | "planner_first"   // I: Complex task 直接 → Cloud Planner 產生計畫 → Local 實作
  | "executor_first"  // J: Critical path → Cloud Executor 產出 patch → Local 驗證
  | "cloud_only";     // K: Full Cloud（Claude/GPT，無 Control Plane）

export interface CloudModelConfig {
  reviewer?: string;
  planner?: string;
  executor?: string;
}

export interface ExecutionStrategy {
  strategy: "local_only" | "hybrid" | "cloud_only";
  tier: ExecutionTier;
  worker: string;
  model: string;
  allowCloud: boolean;
  maxAttempts: number;
  // Hybrid / Cloud 專用
  escalationMode?: EscalationMode;
  cloudModels?: CloudModelConfig;
  // Phase 9+：觸發條件
  escalationTriggers?: {
    maxLocalAttempts?: number;
    failureClassifications?: string[];
    complexityThreshold?: "low" | "medium" | "high";
    riskThreshold?: "low" | "medium" | "high";
  };
  // Cloud 成本控制
  cloudLimits?: {
    maxTokensPerTask?: number;
    maxCostPerDayUsd?: number;
  };
}

export interface ResearchSummary {
  /** 通過 shaping 且被收錄進 bundle 的 evidence facts 數。 */
  facts: number;
  /** 來源數（去重後）。 */
  sourcesCount: number;
  /** 官方來源數（official documentation / upstream repo）。 */
  officialSources: number;
}

export type ResearchDecision =
  | { decision: "PASS" }
  | { decision: "RESEARCH_AGAIN"; reason: string };

// §25 Escalation Decision
export type EscalationType =
  | "NOT_SUPPORTED"
  | "ALLOWED"
  | "ALLOWED_WITH_CONDITIONS";

export interface EscalationDecision {
  type: EscalationType;
  reason: string;
  mode?: EscalationMode;
  cloudProvider?: string;
  estimatedCostUsd?: number;
}
