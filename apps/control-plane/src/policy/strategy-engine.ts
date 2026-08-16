// Execution Strategy Engine（Spec §25 Phase 9）。
// 依 task 複雜度、風險、本地失敗歷史選擇 tier，決定是否觸發 escalation。

import type { ExecutionStrategy, ExecutionTier, EscalationMode, EscalationDecision, CloudModelConfig } from "./types.js";
import type { TaskAnalysis } from "./types.js";
import type { TaskRow } from "../task/types.js";

export interface ExecutionStrategyEngineOptions {
  /** Phase 設定：1-5 | 6 | 7 | 8 | 9 | 10 | 11 */
  phase: number;
  /** Cloud 成本上限（USD/天） */
  maxDailyCostUsd?: number;
  /** Cloud token 上限（per task） */
  maxTokensPerTask?: number;
  /** 預設雲端模型設定 */
  defaultCloudModels?: CloudModelConfig;
  /** 是否允許 Cloud（Phase 6+ 才考慮） */
  allowCloud?: boolean;
}

export interface EscalationContext {
  task: TaskRow;
  attempt: number;
  failureClassification?: string;
  localHistory: Array<{ success: boolean; classification?: string }>;
  analysis: TaskAnalysis;
}

export class ExecutionStrategyEngine {
  private readonly opts: Required<ExecutionStrategyEngineOptions>;

  constructor(opts: ExecutionStrategyEngineOptions) {
    this.opts = {
      phase: opts.phase,
      maxDailyCostUsd: opts.maxDailyCostUsd ?? 50.0,
      maxTokensPerTask: opts.maxTokensPerTask ?? 100_000,
      defaultCloudModels: opts.defaultCloudModels ?? {
        reviewer: "claude-3.5-sonnet",
        planner: "claude-3.5-sonnet",
        executor: "gpt-4o",
      },
      allowCloud: opts.allowCloud ?? false,
    };
  }

  /**
   * 選擇執行策略（§25）：依 task 分析、phase、歷史決定 tier。
   * Phase 1–5：強制 local_only
   * Phase 6–8：local_only（但可啟用 MCP/ACP）
   * Phase 9+：支援 local / hybrid / cloud 三層
   */
  selectStrategy(analysis: TaskAnalysis, localHistory: Array<{ success: boolean; classification?: string }> = []): ExecutionStrategy {
    const { phase, allowCloud, defaultCloudModels, maxTokensPerTask, maxDailyCostUsd } = this.opts;

    // Phase 1–5：硬性 local_only（§24 / §38）
    if (phase <= 5) {
      return this.localOnlyStrategy();
    }

    // Phase 6–8：local_only（可選啟用 MCP/ACP，但不上雲）
    if (phase >= 6 && phase <= 8) {
      return this.localOnlyStrategy();
    }

    // Phase 9+：根據複雜度/風險/歷史決定
    const isComplex = analysis.complexity === "high";
    const isHighRisk = analysis.risk === "high";
    const hasLocalFailures = localHistory.some((h) => !h.success);
    const localFailureCount = localHistory.filter((h) => !h.success).length;

    // 決定 tier
    let tier: ExecutionTier = "local";
    let escalationMode: EscalationMode | undefined;

    if (isHighRisk && hasLocalFailures && localFailureCount >= 2) {
      // 高風險 + 多次失敗 → Executor First (J)
      tier = "hybrid";
      escalationMode = "executor_first";
    } else if (isComplex && phase >= 10) {
      // 高複雜度 + Phase 10+ → Planner First (I)
      tier = "hybrid";
      escalationMode = "planner_first";
    } else if (hasLocalFailures && localFailureCount >= 1) {
      // 有失敗歷史 → Reviewer First (H)
      tier = "hybrid";
      escalationMode = "reviewer_first";
    } else if (isHighRisk && phase >= 11) {
      // Phase 11 高風險可選 Cloud Only (K)
      tier = "cloud";
    }

    if (tier === "local") {
      return this.localOnlyStrategy();
    }

    if (tier === "cloud") {
      return this.cloudOnlyStrategy(defaultCloudModels);
    }

    // Hybrid tier
    return this.hybridStrategy(escalationMode!, defaultCloudModels);
  }

  /**
   * 判斷是否觸發 escalation（§25）。
   * 條件：Phase 9+、允許 Cloud、嘗試次數達標、失敗分類符合。
   */
  canEscalate(context: EscalationContext): EscalationDecision {
    const { phase, allowCloud } = this.opts;
    const { task, attempt, failureClassification, localHistory } = context;

    if (phase < 9 || !allowCloud) {
      return { type: "NOT_SUPPORTED", reason: "Phase < 9 或未啟用 Cloud（§25）" };
    }

    // 嘗試次數檢查（至少 2 次本地失敗才考慮 escalation）
    const failureCount = localHistory.filter((h) => !h.success).length;
    if (attempt < 2 && failureCount < 2) {
      return { type: "NOT_SUPPORTED", reason: "本地嘗試次數未達 escalation 門檻（需 ≥2 次失敗）" };
    }

    // 失敗分類檢查
    const escalatableClasses = [
      "coding_error",
      "knowledge_error",
      "model_limitation",
      "tool_error",
    ];
    if (failureClassification && !escalatableClasses.includes(failureClassification)) {
      return { type: "NOT_SUPPORTED", reason: `失敗分類 ${failureClassification} 不支援 escalation` };
    }

    // 決定 escalation mode
    const analysis: TaskAnalysis = {
      languages: [],
      frameworks: [],
      dependencies: [],
      complexity: "medium",
      risk: "medium",
      researchRequired: false,
      researchReasons: [],
    };
    const strategy = this.selectStrategy(analysis, localHistory);

    if (strategy.tier === "local") {
      return { type: "NOT_SUPPORTED", reason: "策略判定為 local_only，無需 escalation" };
    }

    return {
      type: "ALLOWED",
      reason: `觸發 escalation：${strategy.escalationMode}`,
      mode: strategy.escalationMode,
      cloudProvider: "anthropic", // 預設
      estimatedCostUsd: 0.5, // 預估
    };
  }

  /**
   * 建構 Cloud Request（Reviewer/Planner/Executor）。
   */
  buildCloudRequest(
    task: TaskRow,
    mode: "reviewer" | "planner" | "executor",
    context: { patch?: string; errorOutput?: string; plan?: string } = {},
  ): { prompt: string; model: string; maxTokens: number } {
    const { defaultCloudModels, maxTokensPerTask } = this.opts;

    const model = mode === "reviewer"
      ? this.opts.defaultCloudModels.reviewer ?? "claude-3.5-sonnet"
      : mode === "planner"
        ? this.opts.defaultCloudModels.planner ?? "claude-3.5-sonnet"
        : this.opts.defaultCloudModels.executor ?? "gpt-4o";

    const prompts: Record<"reviewer" | "planner" | "executor", string> = {
      reviewer: `你是 Control Plane 的 Cloud Reviewer。請審查以下 patch，指出潛在問題並給出修正建議。

Task: ${task.request}
Workspace: ${task.workspace ?? "N/A"}

${context.patch ? `Patch:\n${context.patch}\n` : ""}
${context.errorOutput ? `Error Output:\n${context.errorOutput}\n` : ""}

輸出格式：
1. 問題清單（嚴重度排序）
2. 修正建議
3. 結論：PASS / CONDITIONAL_PASS / REJECT`,
      planner: `你是 Control Plane 的 Cloud Planner。請為以下任務制定詳細實作計畫。

Task: ${task.request}
Workspace: ${task.workspace ?? "N/A"}

輸出格式：
1. 步驟清單（每步含預期產出與驗證方式）
2. 檔案變更範圍
3. 風險評估與緩解措施`,
      executor: `你是 Control Plane 的 Cloud Executor。請根據計畫直接產出 patch。

Task: ${task.request}
Workspace: ${task.workspace ?? "N/A"}
${context.plan ? `Plan:\n${context.plan}\n` : ""}

輸出格式：
1. 簡短計畫（≤5 行）
2. 完整 unified diff（---/+++ 格式，git apply 可套用）
3. 最後一行：DONE`,
    };

    return {
      prompt: prompts[mode],
      model,
      maxTokens: Math.min(maxTokensPerTask, 50_000),
    };
  }

  private localOnlyStrategy(): ExecutionStrategy {
    return {
      strategy: "local_only",
      tier: "local",
      worker: "pi-local",
      model: "qwen2.5-coder:7b",
      allowCloud: false,
      maxAttempts: 3,
    };
  }

  private hybridStrategy(mode: EscalationMode, cloudModels: CloudModelConfig): ExecutionStrategy {
    return {
      strategy: "hybrid",
      tier: "hybrid",
      worker: "pi-local",
      model: "qwen2.5-coder:7b",
      allowCloud: true,
      maxAttempts: 3,
      escalationMode: mode,
      cloudModels,
      escalationTriggers: {
        maxLocalAttempts: 2,
        failureClassifications: ["coding_error", "knowledge_error", "model_limitation", "tool_error"],
        complexityThreshold: "medium",
        riskThreshold: "medium",
      },
      cloudLimits: {
        maxTokensPerTask: 50_000,
        maxCostPerDayUsd: 50.0,
      },
    };
  }

  private cloudOnlyStrategy(cloudModels: CloudModelConfig): ExecutionStrategy {
    return {
      strategy: "cloud_only",
      tier: "cloud",
      worker: "cloud-executor",
      model: cloudModels.executor ?? "gpt-4o",
      allowCloud: true,
      maxAttempts: 2,
      escalationMode: "cloud_only",
      cloudModels,
      cloudLimits: {
        maxTokensPerTask: 100_000,
        maxCostPerDayUsd: 100.0,
      },
    };
  }
}