// Evidence Gate（spec §14）：沒有 Evidence 就不允許 Implementation 修改 artifact（Rule 3）。
// 兩階段評估（§14.1）+ 降級政策（§14.2）+ 三鐵律（§14.3）+ 卡死防護（§14.4）。
// 全部確定性規則——無任何 LLM 呼叫（§10 Rule 1）。

import type { PolicyEngine } from "../policy/engine.js";
import type { ResearchSummary } from "../policy/types.js";

/** Stage 1：research 執行狀態（§14.1）。 */
export type ResearchStageStatus = "COMPLETE" | "PARTIAL" | "FAILED";

/** Stage 2：證據評估（§14.1）。 */
export type EvidenceVerdict =
  | "SUFFICIENT"
  | "INSUFFICIENT"
  | "INSUFFICIENT_LOW_CONFIDENCE";

export type GateDecisionStatus = "PASS" | "RESEARCH_AGAIN" | "BLOCK" | "DEGRADED";

/** §14.2 降級旗標：scope 標示降級範圍。 */
export type DegradeScope = "implementation" | "verification";

export interface DegradeFlags {
  /** 本次降級範圍：僅 implementation（本地推論）或含 verification。 */
  scope: DegradeScope;
  /** 降級原因（§14.2：research_failure / on_partial / on_failed）。 */
  reason: string;
  /** 原決策（降級前的 GateDecision）。 */
  originalDecision: Exclude<GateDecisionStatus, "DEGRADED">;
  /** 降級由哪個 actor 授權（override 記錄，§14.2：'policy' | 'user'）。 */
  actor: "policy" | "user";
}

export interface EvidenceDecision {
  status: GateDecisionStatus;
  stage1: ResearchStageStatus;
  stage2: EvidenceVerdict;
  reason: string;
  /** 卡死防護已耗費的 research 重試次數（§14.4）。 */
  retriesUsed?: number;
  /** 降級資訊（status === 'DEGRADED' 時必填）。 */
  degraded?: DegradeFlags;
  /** gate block 計數（供 §36.2 Prevention Rate）。 */
  blocks: number;
}

export interface EvidenceGateInput {
  /** Stage 1：research 執行狀態。 */
  stage1: ResearchStageStatus;
  /** Stage 2 輸入：證據摘要（facts / sourcesCount / officialSources）。 */
  summary: ResearchSummary;
  /** task 風險（低風險才可 allow_local 降級，§14.2）。 */
  risk: "low" | "medium" | "high";
  /** §14.4 卡死防護：本次 research 已重試次數。 */
  researchRetries?: number;
}

/** 卡死防護（§14.4）：research 失敗重試 ×2（5s / 30s 退避）後才進入降級判定。 */
export const MAX_RESEARCH_RETRIES = 2;

/**
 * validate(task, bundle) → EvidenceDecision（§14）。
 * 兩階段獨立判定；Stage 2 的知識缺口（INSUFFICIENT_LOW_CONFIDENCE / INSUFFICIENT）
 * 在 Stage 1 為 COMPLETE 時一律 BLOCK——永不降級（§14.1 註記：知識缺口硬性）。
 */
export function validateEvidenceGate(
  input: EvidenceGateInput,
  policy: Pick<PolicyEngine, "evaluateResearch" | "researchFailurePolicy">,
): EvidenceDecision {
  const { stage1, summary, risk } = input;
  const researchRetries = input.researchRetries ?? 0;

  // §14.2 降級政策（由 research_failure 區塊驅動）
  const rf = policy.researchFailurePolicy();
  const maxRetries = rf.maxRetries;

  // ---- Stage 2：證據評估（先獨立判定，供 Stage 1 降級決策參考）----
  const researchDecision = policy.evaluateResearch(summary);
  let stage2: EvidenceVerdict;
  if (researchDecision.decision === "PASS") {
    stage2 = "SUFFICIENT";
  } else if (summary.facts === 0) {
    // 完全沒有證據 → 知識缺口
    stage2 = "INSUFFICIENT_LOW_CONFIDENCE";
  } else {
    stage2 = "INSUFFICIENT";
  }

  // ---- Stage 1：research 執行狀態 ----
  if (stage1 === "FAILED" || stage1 === "PARTIAL") {
    // §14.4 卡死防護：未達重試上限 → RESEARCH_AGAIN（不可直接降級）
    if (researchRetries < maxRetries) {
      return {
        status: "RESEARCH_AGAIN",
        stage1,
        stage2,
        reason: `research_${stage1.toLowerCase()}: retry ${researchRetries + 1}/${maxRetries}（§14.4 ${rf.retryBackoffSeconds.join("s/")}s 退避）`,
        retriesUsed: researchRetries,
        blocks: 0,
      };
    }
    // 重試耗盡 → §14.2 降級判定：on_partial / on_failed 由 policy 驅動
    const policyAction = stage1 === "PARTIAL" ? rf.onPartial : rf.onFailed;
    if (risk === "high") {
      // §14.2 鐵律：高風險不得 allow_local（僅 block / ask_user）
      return {
        status: policyAction === "ask_user" ? "BLOCK" : "BLOCK",
        stage1,
        stage2,
        reason: `high_risk_${stage1.toLowerCase()}_after_retries: 高風險不得降級（§14.2 鐵律）→ ${policyAction}`,
        retriesUsed: researchRetries,
        blocks: 1,
      };
    }
    if (policyAction === "block") {
      return {
        status: "BLOCK",
        stage1,
        stage2,
        reason: `policy_block_on_${stage1.toLowerCase()}_after_retries（research_failure.on_${stage1.toLowerCase()} = block）`,
        retriesUsed: researchRetries,
        blocks: 1,
      };
    }
    if (policyAction === "ask_user") {
      // 高風險或 policy 指定 → BLOCK（狀態機轉 ASK_USER）；低風險 allow_local 例外
      if (stage2 === "SUFFICIENT" || summary.sourcesCount > 0) {
        // policy 指定 ask_user：不擅自降級，交給使用者
        return {
          status: "BLOCK",
          stage1,
          stage2,
          reason: `ask_user_on_${stage1.toLowerCase()}_after_retries（§14.2 on_failed = ask_user）`,
          retriesUsed: researchRetries,
          blocks: 1,
        };
      }
      return {
        status: "BLOCK",
        stage1,
        stage2,
        reason: `ask_user_on_${stage1.toLowerCase()}_after_retries: 本地證據不足（§14.1 知識缺口）`,
        retriesUsed: researchRetries,
        blocks: 1,
      };
    }
    // policyAction === "allow_local"：低/中風險 + 本地證據足夠
    if (stage2 === "SUFFICIENT" || summary.sourcesCount > 0) {
      return {
        status: "DEGRADED",
        stage1,
        stage2,
        reason: `allow_local_on_${stage1.toLowerCase()}_after_retries（§14.2 低風險 + 本地證據足夠）`,
        retriesUsed: researchRetries,
        degraded: {
          scope: "implementation",
          reason: `research_${stage1.toLowerCase()}_after_retries`,
          originalDecision: stage2 === "SUFFICIENT" ? "PASS" : "RESEARCH_AGAIN",
          actor: "policy",
        },
        blocks: 0,
      };
    }
    // 本地證據也不足 → 知識缺口，BLOCK
    return {
      status: "BLOCK",
      stage1,
      stage2,
      reason: `insufficient_local_evidence_after_retries: 本地證據不足（§14.1 知識缺口）`,
      retriesUsed: researchRetries,
      blocks: 1,
    };
  }

  // ---- Stage 1 = COMPLETE：Stage 2 決定 ----
  if (stage2 === "SUFFICIENT") {
    return { status: "PASS", stage1, stage2, reason: "evidence sufficient", blocks: 0 };
  }
  // Stage 2 知識缺口（COMPLETE + INSUFFICIENT*）→ BLOCK，永不降級（§14.1 硬性）
  return {
    status: "BLOCK",
    stage1,
    stage2,
    reason:
      stage2 === "INSUFFICIENT_LOW_CONFIDENCE"
        ? "knowledge_gap_low_confidence: 證據不足且低信心（§14.1 BLOCK 永不降級）"
        : "knowledge_gap: 證據不足以支撐實施（§14.1 BLOCK 永不降級）",
    blocks: 1,
  };
}
