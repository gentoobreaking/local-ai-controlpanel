// Policy Engine（spec §10）。
// 全部決策皆為確定性規則——無任何 LLM 呼叫（Rule 1）。
// Knowledge Policy 是核心：unknown_dependency / version_sensitive / external_api /
// unfamiliar_framework / security_sensitive / low_confidence … → REQUIRE_RESEARCH。

import { minimatch } from "minimatch";
import type { LoadedPolicies } from "./loader.js";
import type { DefaultPolicy } from "./schemas.js";
import type { TaskRow } from "../task/types.js";
import type {
  ArtifactDecision,
  EscalationDecision,
  ExecutionStrategy,
  ResearchDecision,
  ResearchSummary,
  TaskAnalysis,
  TaskPolicyDecision,
  ToolDecision,
  ToolRequest,
  CloudModelConfig,
} from "./types.js";
import { ExecutionStrategyEngine } from "./strategy-engine.js";

export class PolicyEngine {
  private readonly strategyEngine: ExecutionStrategyEngine;

  constructor(
    private readonly policies: LoadedPolicies,
    private readonly opts: { enabled?: boolean; phase?: number; allowCloud?: boolean } = {},
  ) {
    this.strategyEngine = new ExecutionStrategyEngine({
      phase: opts.phase ?? 1,
      allowCloud: opts.allowCloud ?? false,
      defaultCloudModels: {
        reviewer: "claude-3.5-sonnet",
        planner: "claude-3.5-sonnet",
        executor: "gpt-4o",
      },
    });
  }

  get enabled(): boolean {
    return this.opts.enabled ?? true;
  }

  get defaultPolicy(): DefaultPolicy {
    return this.policies.defaultPolicy;
  }

  private get research() {
    return this.policies.defaultPolicy.research;
  }

  private get permissions() {
    // security.yaml 優先，缺則用 default.yaml（兩者內容一致）
    return this.policies.security?.permissions ?? this.policies.defaultPolicy.permissions;
  }

  /**
   * evaluateTask（§10 / §11）：以 TaskAnalysis 的 researchReasons 對照
   * research.required_when → REQUIRE_RESEARCH；高風險 task 也一律要求研究。
   */
  evaluateTask(analysis: TaskAnalysis): TaskPolicyDecision {
    if (!this.enabled) return { action: "ALLOW_PLANNING" };
    const reasons: string[] = [];
    if (!this.research.enabled) return { action: "ALLOW_PLANNING" };

    for (const r of analysis.researchReasons) {
      if (this.research.required_when.includes(r) && !reasons.includes(r)) {
        reasons.push(r);
      }
    }
    if (analysis.risk === "high" && !reasons.includes("high_risk_change")) {
      reasons.push("high_risk_change");
    }
    return reasons.length > 0
      ? { action: "REQUIRE_RESEARCH", reasons }
      : { action: "ALLOW_PLANNING" };
  }

  /**
   * evaluateArtifact（§10 / §20）：依 artifact.allowed / readonly / forbidden 決策。
   * 不在 allowed → DENIED；命中 forbidden → DENIED；命中 readonly → DENIED。
   */
  evaluateArtifact(
    files: string[],
    policy?: DefaultPolicy["artifact"],
  ): ArtifactDecision {
    const artifact = policy ?? this.policies.defaultPolicy.artifact;
    if (!artifact) {
      throw new Error("default policy 缺少 artifact 設定（§10）");
    }
    const violations: ArtifactDecision["violations"] = [];
    for (const file of files) {
      if (artifact.forbidden.some((p) => minimatch(file, p))) {
        violations.push({ file, rule: "forbidden" });
        continue;
      }
      if (artifact.readonly.some((p) => minimatch(file, p))) {
        violations.push({ file, rule: "readonly" });
        continue;
      }
      if (!artifact.allowed.some((p) => minimatch(file, p))) {
        violations.push({ file, rule: "not_allowed" });
      }
    }
    return violations.length > 0
      ? { verdict: "DENIED", violations }
      : { verdict: "APPROVED", violations };
  }

  /**
   * evaluateTool（§28）：permissions 政策控制。
   * network 預設禁（僅 Research Engine 有網）；shell 必須進 sandbox。
   */
  evaluateTool(req: ToolRequest): ToolDecision {
    const perms = this.permissions;
    switch (req.tool) {
      case "network":
        return perms?.network?.enabled === false
          ? { verdict: "DENY", reason: "network_disabled（§28：本地 Worker 預設禁網）" }
          : { verdict: "ALLOW", reason: "network allowed" };
      case "shell":
        return perms?.shell?.enabled === false
          ? { verdict: "DENY", reason: "shell_disabled" }
          : perms?.shell?.sandbox === true
            ? { verdict: "ALLOW_IN_SANDBOX", reason: "shell 必須在 sandbox 內執行（§28 Rule 8）" }
            : { verdict: "ALLOW", reason: "shell allowed" };
      case "filesystem_read":
        return perms?.filesystem?.read === false
          ? { verdict: "DENY", reason: "filesystem_read_denied" }
          : { verdict: "ALLOW", reason: "filesystem read allowed" };
      case "filesystem_write":
        return perms?.filesystem?.write === "policy-controlled"
          ? { verdict: "ALLOW_IN_SANDBOX", reason: "write 需經 Artifact Controller + sandbox（§20）" }
          : { verdict: "DENY", reason: "filesystem_write_denied" };
      case "git_read":
        return { verdict: "ALLOW", reason: "git read allowed" };
      case "git_write":
        return perms?.git?.write === "policy-controlled"
          ? { verdict: "ALLOW_IN_SANDBOX", reason: "git write 需經 Artifact Controller（§20）" }
          : { verdict: "DENY", reason: "git_write_denied" };
      default:
        return { verdict: "DENY", reason: `unknown_tool: ${req.tool}` };
    }
  }

  /**
   * evaluateExecution（§10 / §24 / §25）：Phase 1–5 強制 local_only。
   * Phase 9+ 依 task 分析與歷史決定 tier（local / hybrid / cloud）。
   * allow_cloud 為 true 且 Phase < 9 → throw（程式層硬限制，非 prompt）。
   */
  evaluateExecution(analysis?: TaskAnalysis): ExecutionStrategy {
    const ex = this.policies.defaultPolicy.execution;

    // Phase 1–5：硬性 local_only（§24 / §38）
    const phase = this.strategyEngine["opts"].phase;
    if (phase <= 5) {
      if (ex.allow_cloud === true) {
        throw new Error(
          "Phase 1–5 硬限制（§24）：execution.allow_cloud 必須為 false",
        );
      }
      return this.localOnlyStrategy(ex);
    }

    // Phase 6–8：local_only（可選啟用 MCP/ACP，但不上雲）
    if (phase >= 6 && phase <= 8) {
      return this.localOnlyStrategy(ex);
    }

    // Phase 9+：使用 Strategy Engine 決定
    if (!analysis) {
      // 無分析時回傳預設 local
      return this.localOnlyStrategy(ex);
    }

    // 取得本地失敗歷史（簡化：從 DB 讀取，這裡先回傳空）
    const localHistory: Array<{ success: boolean; classification?: string }> = [];

    return this.strategyEngine.selectStrategy(analysis, localHistory);
  }

  private localOnlyStrategy(ex: DefaultPolicy["execution"]): ExecutionStrategy {
    return {
      strategy: "local_only",
      tier: "local",
      worker: ex.local.worker,
      model: ex.local.model,
      allowCloud: false,
      maxAttempts: ex.local.max_attempts,
    };
  }

  /**
   * evaluateResearch（§14 供 T019 Evidence Gate 使用）：
   * evidence 來源數不足 → RESEARCH_AGAIN。
   */
  evaluateResearch(summary: ResearchSummary): ResearchDecision {
    if (!this.enabled) return { decision: "PASS" };
    if (summary.sourcesCount < this.research.minimum_sources) {
      return {
        decision: "RESEARCH_AGAIN",
        reason: `insufficient_sources: ${summary.sourcesCount} < ${this.research.minimum_sources}`,
      };
    }
    return { decision: "PASS" };
  }

  /** §14.2 降級政策查詢：research 失敗後的 on_partial / on_failed 行為。 */
  researchFailurePolicy(): {
    onPartial: "allow_local" | "ask_user" | "block";
    onFailed: "allow_local" | "ask_user" | "block";
    maxRetries: number;
    retryBackoffSeconds: number[];
  } {
    if (!this.enabled) {
      return { onPartial: "allow_local", onFailed: "allow_local", maxRetries: 0, retryBackoffSeconds: [] };
    }
    const rf = this.research.research_failure;
    return {
      onPartial: rf?.on_partial ?? "allow_local",
      onFailed: rf?.on_failed ?? "ask_user",
      maxRetries: rf?.max_retries ?? 2,
      retryBackoffSeconds: rf?.retry_backoff_seconds ?? [5, 30],
    };
  }

  /** §23 retry policy：max_attempts 上限（缺省 3）。 */
  retryMaxAttempts(): number {
    return this.policies.defaultPolicy.retry?.max_attempts ?? 3;
  }

  /** §20 artifact.allowed：worker 可修改的檔案 glob（T021 executionPolicy.allowedFiles）。 */
  allowedFiles(): string[] {
    return this.policies.defaultPolicy.artifact?.allowed ?? [];
  }

  /** §20 artifact.readonly：worker 唯讀檔案 glob。 */
  readonlyFiles(): string[] {
    return this.policies.defaultPolicy.artifact?.readonly ?? [];
  }

  /** §21 verification.required：驗證指令（對應 verifier 名稱）。 */
  verificationCommands(): string[] {
    return this.policies.defaultPolicy.verification?.required ?? [];
  }

  /**
   * §23 retry.on 表：依 failure class 給動作（規範化 repair → repair_environment）。
   * policy 未定義該 class 時回 undefined（由 reflection engine 用預設映射）。
   */
  retryActionFor(classification: string): string | undefined {
    const on = this.policies.defaultPolicy.retry?.on;
    if (!on) return undefined;
    const action = (on as Record<string, string | undefined>)[classification];
    if (!action) return undefined;
    return action === "repair" ? "repair_environment" : action;
  }

  /**
   * evaluateEscalation（§25 Phase 9）：判斷是否觸發 Cloud Escalation。
   * Phase 1–8：NOT_SUPPORTED
   * Phase 9+：依嘗試次數、失敗分類、策略引擎決定
   */
  evaluateEscalation(context?: {
    attempt: number;
    failureClassification?: string;
    localHistory?: Array<{ success: boolean; classification?: string }>;
    analysis?: TaskAnalysis;
  }): EscalationDecision {
    if (!context) {
      return {
        type: "NOT_SUPPORTED",
        reason: "缺少 escalation 上下文",
      };
    }
    return this.strategyEngine.canEscalate({
      task: { id: "unknown", status: "IMPLEMENTING" } as any,
      attempt: context.attempt,
      failureClassification: context.failureClassification,
      localHistory: context.localHistory ?? [],
      analysis: context.analysis ?? { complexity: "medium", risk: "medium" } as any,
    });
  }

  /**
   * buildCloudRequest（§25）：建構 Cloud Request（Reviewer/Planner/Executor）。
   */
  buildCloudRequest(
    task: TaskRow,
    mode: "reviewer" | "planner" | "executor",
    context?: { patch?: string; errorOutput?: string; plan?: string },
  ): { prompt: string; model: string; maxTokens: number } {
    return this.strategyEngine.buildCloudRequest(task, mode, context);
  }
}
