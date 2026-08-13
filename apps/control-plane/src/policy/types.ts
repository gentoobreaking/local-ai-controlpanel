// Policy Engine 決策型別（spec §10 / §11 / §14 / §20 / §24）。
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

export interface ExecutionStrategy {
  strategy: "local_only";
  tier: "local";
  worker: string;
  model: string;
  allowCloud: false;
  maxAttempts: number;
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

export interface EscalationDecision {
  type: "NOT_SUPPORTED";
  reason: string;
}
