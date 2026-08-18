// Evidence Gate 簡化 API（Spec §14）
//
// 提供基於證據總分的通過/失敗判斷：
// - 閾值邏輯：證據總分 ≥ 0.7 通過（可調整）
// - 證據加權計算：不同來源權重不同
// - 失敗原因列出：哪些證據不足、權重不夠

import type { EvidenceSource, EvidenceScoringWeights } from "./types.js";
import { DEFAULT_EVIDENCE_WEIGHTS, EVIDENCE_PASS_THRESHOLD } from "./types.js";

export interface GateThresholds {
  /** 總分通過門檻 */
  passThreshold: number;
  /** 最少證據數量 */
  minEvidenceCount: number;
  /** 單一證據最低分數 */
  minSingleScore: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  passThreshold: EVIDENCE_PASS_THRESHOLD,
  minEvidenceCount: 1,
  minSingleScore: 0.3,
};

export interface GateInput {
  /** 證據列表 */
  evidence: EvidenceSource[];
  /** 自定義權重 */
  weights?: Partial<EvidenceScoringWeights>;
  /** 自定義門檻 */
  thresholds?: Partial<GateThresholds>;
  /** 任務風險等級 */
  risk?: "low" | "medium" | "high";
}

export interface GateReason {
  type: "insufficient_total_score" | "insufficient_evidence_count" | "low_single_score" | "high_risk_blocked";
  message: string;
  details?: Record<string, unknown>;
}

export interface GateResult {
  /** 通過狀態 */
  status: "pass" | "fail";
  /** 總分 (0.0-1.0) */
  score: number;
  /** 失敗原因列表 */
  reasons: GateReason[];
  /** 證據統計 */
  stats: {
    totalEvidence: number;
    passedEvidence: number;
    avgScore: number;
    byType: Record<string, { count: number; avgScore: number }>;
  };
  /** 時間戳 */
  timestamp: string;
}

function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    documentation: "文檔",
    code_execution: "代碼執行",
    external_api: "外部 API",
    memory: "專案記憶",
    style_kb: "風格知識庫",
  };
  return labels[type] ?? type;
}

export class EvidenceGate {
  private defaultWeights: EvidenceScoringWeights;
  private defaultThresholds: GateThresholds;

  constructor(opts: { weights?: Partial<EvidenceScoringWeights>; thresholds?: Partial<GateThresholds> } = {}) {
    this.defaultWeights = { ...DEFAULT_EVIDENCE_WEIGHTS, ...opts.weights };
    this.defaultThresholds = { ...DEFAULT_GATE_THRESHOLDS, ...opts.thresholds };
  }

  /**
   * 執行 Gate 判斷
   */
  evaluate(input: GateInput): GateResult {
    const { evidence, weights: customWeights, thresholds: customThresholds, risk } = input;

    const weights = { ...this.defaultWeights, ...customWeights };
    const thresholds = { ...this.defaultThresholds, ...customThresholds };

    const reasons: GateReason[] = [];

    // 1. 統計各類型證據
    const byType: Record<string, { count: number; avgScore: number; totalScore: number }> = {};

    for (const e of evidence) {
      if (!byType[e.type]) {
        byType[e.type] = { count: 0, avgScore: 0, totalScore: 0 };
      }
      const entry = byType[e.type]!;
      entry.count++;
      entry.totalScore += e.score;
    }

    // 計算平均分
    for (const key of Object.keys(byType)) {
      const entry = byType[key]!;
      entry.avgScore = entry.totalScore / entry.count;
    }

    // 2. 檢查證據數量
    const minEvidenceCount = thresholds.minEvidenceCount ?? 1;
    if (evidence.length < minEvidenceCount) {
      reasons.push({
        type: "insufficient_evidence_count",
        message: `證據數量不足：${evidence.length} < ${minEvidenceCount}`,
        details: { current: evidence.length, required: minEvidenceCount },
      });
    }

    // 3. 檢查單一證據最低分
    const minSingleScore = thresholds.minSingleScore ?? 0.3;
    const lowScoreEvidence = evidence.filter((e) => e.score < minSingleScore);
    if (lowScoreEvidence.length > 0) {
      reasons.push({
        type: "low_single_score",
        message: `存在 ${lowScoreEvidence.length} 條低分證據（< ${minSingleScore}）`,
        details: { lowScoreCount: lowScoreEvidence.length, threshold: minSingleScore },
      });
    }

    // 4. 高風險阻擋
    if (risk === "high" && evidence.length > 0) {
      // 高風險任務要求更嚴格：至少 2 條證據且平均分 ≥ 0.8
      const highRiskThreshold = 0.8;
      const avgScore = evidence.length > 0
        ? evidence.reduce((sum, e) => sum + e.score, 0) / evidence.length
        : 0;

      if (evidence.length < 2 || avgScore < highRiskThreshold) {
        reasons.push({
          type: "high_risk_blocked",
          message: `高風險任務要求更嚴格：證據 ≥ 2 且平均分 ≥ ${highRiskThreshold}（當前：${evidence.length} 條，平均分 ${avgScore.toFixed(2)}）`,
          details: { evidenceCount: evidence.length, avgScore, requiredAvgScore: highRiskThreshold, requiredMinCount: 2 },
        });
      }
    }

    // 5. 計算總分
    let totalScore = 0;
    if (evidence.length > 0) {
      // 加權平均：按類型權重
      let weightedSum = 0;
      let totalWeight = 0;

      for (const [type, stats] of Object.entries(byType)) {
        const weight = weights[type as keyof EvidenceScoringWeights] ?? 1.0;
        weightedSum += stats.avgScore * weight * stats.count;
        totalWeight += weight * stats.count;
      }

      totalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    }

    // 6. 檢查總分門檻
    const passThreshold = thresholds.passThreshold ?? EVIDENCE_PASS_THRESHOLD;
    if (totalScore < passThreshold) {
      reasons.push({
        type: "insufficient_total_score",
        message: `總分不足：${totalScore.toFixed(3)} < ${passThreshold}`,
        details: { score: totalScore, threshold: passThreshold },
      });
    }

    // 7. 準備統計資料
    const passedEvidence = evidence.filter((e) => e.score >= minSingleScore).length;

    const statsByType: Record<string, { count: number; avgScore: number }> = {};
    for (const [type, stats] of Object.entries(byType)) {
      statsByType[type] = { count: stats.count, avgScore: stats.avgScore };
    }

    return {
      status: reasons.length === 0 ? "pass" : "fail",
      score: totalScore,
      reasons,
      stats: {
        totalEvidence: evidence.length,
        passedEvidence,
        avgScore: evidence.length > 0 ? evidence.reduce((sum, e) => sum + e.score, 0) / evidence.length : 0,
        byType: statsByType,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

export function createEvidenceGate(opts: { weights?: Partial<EvidenceScoringWeights>; thresholds?: Partial<GateThresholds> } = {}): EvidenceGate {
  return new EvidenceGate(opts);
}