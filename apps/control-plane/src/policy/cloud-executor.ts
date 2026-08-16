// Cloud Executor（Spec §25 Phase 9）：四種 Hybrid Escalation Modes 實作。
// H: Reviewer First  — Local 失敗 → Cloud Reviewer 審查 patch → Local 重做
// I: Planner First  — Complex task 直接 → Cloud Planner 產生計畫 → Local 實作
// J: Executor First — Critical path → Cloud Executor 產出 patch → Local 驗證
// K: Cloud Only     — Full Cloud（Claude/GPT，無 Control Plane）

import type { CloudProvider, CloudProviderManager } from "./cloud-provider.js";
import type { CloudChatRequest, CloudChatResponse } from "./cloud-provider.js";
import type { ExecutionStrategy, EscalationMode } from "./types.js";
import type { TaskRow } from "../task/types.js";
import type { WorkerRequest, WorkerResult } from "../worker/types.js";

export type EscalationModeType = "reviewer_first" | "planner_first" | "executor_first" | "cloud_only";

export interface CloudEscalationContext {
  task: TaskRow;
  attempt: number;
  failureClassification?: string;
  localPatch?: string;
  errorOutput?: string;
  localPlan?: string;
}

export interface EscalationResult {
  success: boolean;
  mode: EscalationModeType;
  cloudResponse?: { prompt: string; model: string; maxTokens: number };
  cloudOutput?: string;
  patch?: string;
  changedFiles?: string[];
  error?: string;
  costUsd?: number;
}

export class CloudExecutor {
  private readonly providerManager: CloudProviderManager;
  private readonly defaultProviderType: "anthropic" | "openai" | "gemini";
  private readonly maxDailyCostUsd: number;
  private readonly maxTokensPerTask: number;

  constructor(opts: {
    providerManager: CloudProviderManager;
    defaultProvider?: "anthropic" | "openai" | "gemini";
    maxDailyCostUsd?: number;
    maxTokensPerTask?: number;
  }) {
    this.providerManager = opts.providerManager;
    this.defaultProviderType = opts.defaultProvider ?? "anthropic";
    this.maxDailyCostUsd = opts.maxDailyCostUsd ?? 50.0;
    this.maxTokensPerTask = opts.maxTokensPerTask ?? 100_000;
  }

  /**
   * 執行指定模式的 Cloud Escalation（§25 Baseline H–K）。
   */
  async executeEscalation(
    mode: EscalationModeType,
    context: CloudEscalationContext,
    providerType?: "anthropic" | "openai" | "gemini",
  ): Promise<EscalationResult> {
    const provider = this.providerManager.get(providerType ?? this.defaultProviderType);
    if (!provider) {
      return { success: false, mode, error: `Provider ${providerType ?? this.defaultProviderType} not registered` };
    }

    // 檢查成本預算
    const estimatedCost = 0.5; // 預估
    if (!this.providerManager.canAfford(estimatedCost, this.maxDailyCostUsd)) {
      return { success: false, mode, error: `Daily cost limit (${this.maxDailyCostUsd} USD) exceeded` };
    }

    const providerConfig = { maxTokensPerTask: this.maxTokensPerTask };
    switch (mode) {
      case "reviewer_first":
        return this.executeReviewerFirst(context, provider, providerConfig);
      case "planner_first":
        return this.executePlannerFirst(context, provider, providerConfig);
      case "executor_first":
        return this.executeExecutorFirst(context, provider, providerConfig);
      case "cloud_only":
        return this.executeCloudOnly(context, provider, providerConfig);
      default:
        return { success: false, mode, error: `Unknown mode: ${mode}` };
    }
  }

  // H: Reviewer First — Local 失敗 → Cloud Reviewer 審查 patch → Local 重做
  private async executeReviewerFirst(
    context: CloudEscalationContext,
    provider: CloudProvider,
    config: { maxTokensPerTask: number },
  ): Promise<EscalationResult> {
    if (!context.localPatch) {
      return { success: false, mode: "reviewer_first", error: "Reviewer First 需要 local patch 供審查" };
    }

    const request: CloudChatRequest = {
      messages: [
        { role: "system", content: `你是 Control Plane 的 Cloud Reviewer。請審查以下 patch，指出潛在問題並給出修正建議。` },
        {
          role: "user",
          content: `Task: ${context.task.request}
Workspace: ${context.task.workspace ?? "N/A"}

Local Patch:
${context.localPatch}

${context.errorOutput ? `Error Output:\n${context.errorOutput}\n` : ""}

輸出格式：
1. 問題清單（嚴重度排序）
2. 修正建議
3. 結論：PASS / CONDITIONAL_PASS / REJECT`,
        },
      ],
      model: "claude-3.5-sonnet",
      maxTokens: Math.min(this.maxTokensPerTask, 20_000),
      temperature: 0.2,
    };

    const response = await provider.chat(request);
    const cost = provider.estimateCost(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);
    this.providerManager.trackCost(cost);

    // 解析結論
    const conclusion = this.parseReviewerConclusion(response.text);
    return {
      success: conclusion !== "REJECT",
      mode: "reviewer_first",
      cloudResponse: { prompt: "", model: "claude-3.5-sonnet", maxTokens: 20_000 },
      cloudOutput: response.text,
      costUsd: cost,
    };
  }

  // I: Planner First — Complex task 直接 → Cloud Planner 產生計畫 → Local 實作
  private async executePlannerFirst(
    context: CloudEscalationContext,
    provider: CloudProvider,
    config: { maxTokensPerTask: number },
  ): Promise<EscalationResult> {
    const request: CloudChatRequest = {
      messages: [
        { role: "system", content: `你是 Control Plane 的 Cloud Planner。請為以下任務制定詳細實作計畫。` },
        {
          role: "user",
          content: `Task: ${context.task.request}
Workspace: ${context.task.workspace ?? "N/A"}

輸出格式：
1. 步驟清單（每步含預期產出與驗證方式）
2. 檔案變更範圍
3. 風險評估與緩解措施`,
        },
      ],
      model: "claude-3.5-sonnet",
      maxTokens: Math.min(this.maxTokensPerTask, 30_000),
      temperature: 0.3,
    };

    const response = await provider.chat(request);
    const cost = provider.estimateCost(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);
    this.providerManager.trackCost(cost);

    return {
      success: true,
      mode: "planner_first",
      cloudResponse: { prompt: "", model: "claude-3.5-sonnet", maxTokens: 30_000 },
      cloudOutput: response.text,
      costUsd: cost,
    };
  }

  // J: Executor First — Critical path → Cloud Executor 產出 patch → Local 驗證
  private async executeExecutorFirst(
    context: CloudEscalationContext,
    provider: CloudProvider,
    config: { maxTokensPerTask: number },
  ): Promise<EscalationResult> {
    const request: CloudChatRequest = {
      messages: [
        { role: "system", content: `你是 Control Plane 的 Cloud Executor。請根據計畫直接產出 patch。` },
        {
          role: "user",
          content: `Task: ${context.task.request}
Workspace: ${context.task.workspace ?? "N/A"}
${context.localPlan ? `Plan:\n${context.localPlan}\n` : ""}

輸出格式：
1. 簡短計畫（≤5 行）
2. 完整 unified diff（---/+++ 格式，git apply 可套用）
3. 最後一行：DONE`,
        },
      ],
      model: "gpt-4o",
      maxTokens: Math.min(this.maxTokensPerTask, 50_000),
      temperature: 0.1,
    };

    const response = await provider.chat(request);
    const cost = provider.estimateCost(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);
    this.providerManager.trackCost(cost);

    const patch = this.extractPatch(response.text);
    return {
      success: !!patch,
      mode: "executor_first",
      cloudResponse: { prompt: "", model: "gpt-4o", maxTokens: 50_000 },
      cloudOutput: response.text,
      patch,
      costUsd: cost,
    };
  }

  // K: Cloud Only — Full Cloud（Claude/GPT，無 Control Plane）
  private async executeCloudOnly(
    context: CloudEscalationContext,
    provider: CloudProvider,
    config: { maxTokensPerTask: number },
  ): Promise<EscalationResult> {
    const request: CloudChatRequest = {
      messages: [
        { role: "system", content: `你是一個完整的 AI coding agent。請完成以下任務並產出 patch。` },
        {
          role: "user",
          content: `Task: ${context.task.request}
Workspace: ${context.task.workspace ?? "N/A"}

輸出格式：
1. 計畫（≤5 行）
2. 完整 unified diff（---/+++ 格式，git apply 可套用）
3. 最後一行：DONE`,
        },
      ],
      model: "claude-3.5-sonnet",
      maxTokens: Math.min(this.maxTokensPerTask, 100_000),
      temperature: 0.2,
    };

    const response = await provider.chat(request);
    const cost = provider.estimateCost(response.usage?.inputTokens ?? 0, response.usage?.outputTokens ?? 0);
    this.providerManager.trackCost(cost);

    const patch = this.extractPatch(response.text);
    return {
      success: !!patch,
      mode: "cloud_only",
      cloudResponse: { prompt: "", model: "claude-3.5-sonnet", maxTokens: 100_000 },
      cloudOutput: response.text,
      patch,
      costUsd: cost,
    };
  }

  private parseReviewerConclusion(text: string): "PASS" | "CONDITIONAL_PASS" | "REJECT" {
    const lower = text.toLowerCase();
    if (lower.includes("reject")) return "REJECT";
    if (lower.includes("conditional") || lower.includes("conditional_pass")) return "CONDITIONAL_PASS";
    return "PASS";
  }

  private extractPatch(text: string): string | undefined {
    const start = text.indexOf("--- ");
    if (start === -1) return undefined;
    const end = text.indexOf("\nDONE") ?? text.indexOf("\nFAILED:") ?? text.length;
    return text.slice(start, end).trim();
  }
}