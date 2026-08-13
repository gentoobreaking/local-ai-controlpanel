// Policy Engine（spec §10）。
// 全部決策皆為確定性規則——無任何 LLM 呼叫（Rule 1）。
// Knowledge Policy 是核心：unknown_dependency / version_sensitive / external_api /
// unfamiliar_framework / security_sensitive / low_confidence … → REQUIRE_RESEARCH。

import { minimatch } from "minimatch";
import type { LoadedPolicies } from "./loader.js";
import type { DefaultPolicy } from "./schemas.js";
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
} from "./types.js";

export class PolicyEngine {
  constructor(private readonly policies: LoadedPolicies) {}

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
   * evaluateExecution（§10 / §24）：Phase 1–5 強制 local_only。
   * allow_cloud 為 true → throw（程式層硬限制，非 prompt）。
   */
  evaluateExecution(): ExecutionStrategy {
    const ex = this.policies.defaultPolicy.execution;
    if (ex.allow_cloud === true) {
      throw new Error(
        "Phase 1–5 硬限制（§24）：execution.allow_cloud 必須為 false",
      );
    }
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
    if (summary.sourcesCount < this.research.minimum_sources) {
      return {
        decision: "RESEARCH_AGAIN",
        reason: `insufficient_sources: ${summary.sourcesCount} < ${this.research.minimum_sources}`,
      };
    }
    return { decision: "PASS" };
  }

  /**
   * evaluateEscalation：型別預留。Phase 1–5 一律 NOT_SUPPORTED（§25）。
   */
  evaluateEscalation(): EscalationDecision {
    return {
      type: "NOT_SUPPORTED",
      reason: "Phase 1–5 escalation 停用（§25）；Phase 9 才啟用",
    };
  }
}
