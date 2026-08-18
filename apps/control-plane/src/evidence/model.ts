// Evidence Model（Spec §13）
//
// 實作證據收集、來源標記與評分機制：
// - 證據類型：documentation、code_execution、external_api、memory、style_kb
// - 來源標記：URL/路徑、時間戳、元數據
// - 評分模型：可信度、相關性、及時性、加權總分
// - 連接 Verification Engine 重用驗證結果

import type {
  EvidenceType,
  EvidenceSource,
  EvidenceQuery,
  EvidenceResult,
  EvidenceScoringWeights,
} from "./types.js";
import { ResearchEngine } from "../research/engine.js";
import { VerificationEngine } from "../verification/engine.js";
import { DEFAULT_EVIDENCE_WEIGHTS, EVIDENCE_PASS_THRESHOLD } from "./types.js";

export function computeCredibility(source: EvidenceSource): number {
  let baseCredibility = 0.5;

  switch (source.type) {
    case "documentation":
      baseCredibility = 0.9;
      break;
    case "code_execution":
      baseCredibility = 1.0;
      break;
    case "external_api":
      baseCredibility = 0.7;
      break;
    case "memory":
      baseCredibility = 0.8;
      break;
    case "style_kb":
      baseCredibility = 0.85;
      break;
  }

  // 根據元數據調整
  if (source.metadata) {
    if (source.metadata.official === true) baseCredibility = Math.min(1.0, baseCredibility + 0.1);
    if (source.metadata.verified === true) baseCredibility = Math.min(1.0, baseCredibility + 0.05);
  }

  return Math.min(1.0, Math.max(0.0, baseCredibility));
}

export function computeTimeliness(createdAt?: string): number {
  if (!createdAt) return 0.5;

  const now = Date.now();
  const created = new Date(createdAt).getTime();
  const ageMs = now - created;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // 及時性隨時間衰減：7天內 1.0，30天 0.7，90天 0.4，180天 0.2
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 30) return 0.8;
  if (ageDays <= 90) return 0.5;
  if (ageDays <= 180) return 0.3;
  return 0.1;
}

export function computeWeightedScore(
  source: EvidenceSource,
  weights: EvidenceScoringWeights,
): number {
  const typeWeight = weights[source.type] ?? 1.0;
  return Math.min(1.0, (source.credibility * 0.4 + source.relevance * 0.4 + source.timeliness * 0.2) * typeWeight);
}

export function deduplicateEvidence(evidence: EvidenceSource[]): EvidenceSource[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const key = `${e.type}:${e.id}:${e.snippet.slice(0, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class EvidenceModel {
  private researchEngine?: ResearchEngine;
  private verificationEngine?: VerificationEngine;
  private weights: EvidenceScoringWeights;

  constructor(opts: { weights?: Partial<EvidenceScoringWeights>; researchEngine?: ResearchEngine; verificationEngine?: VerificationEngine } = {}) {
    this.researchEngine = opts.researchEngine;
    this.verificationEngine = opts.verificationEngine;
    this.weights = { ...DEFAULT_EVIDENCE_WEIGHTS, ...opts.weights };
  }

  setResearchEngine(engine: ResearchEngine): void {
    this.researchEngine = engine;
  }

  setVerificationEngine(engine: VerificationEngine): void {
    this.verificationEngine = engine;
  }

  /**
   * 收集證據
   */
  async collectEvidence(query: EvidenceQuery): Promise<EvidenceResult> {
    const allEvidence: EvidenceSource[] = [];

    // 1. 從 Research Engine 獲取證據
    if (this.researchEngine) {
      const researchResult = await this.researchEngine.research({
        taskId: query.taskId,
        query: query.query,
        topK: query.maxResults ?? 10,
      });

      for (const e of researchResult.evidence) {
        // 將 ResearchEngine 的 EvidenceSource 轉換為 EvidenceModel 的 EvidenceSource
        const source: EvidenceSource = {
          type: e.type === "memory" ? "memory" : e.type === "style-kb" ? "style_kb" : "documentation",
          id: e.id,
          title: e.title,
          url: e.url,
          snippet: e.snippet,
          fullContent: e.metadata?.fullContent as string | undefined,
          credibility: 0.5, // 稍後計算
          relevance: e.confidence,
          timeliness: 0.5, // 稍後計算
          score: 0,
          accessedAt: new Date().toISOString(),
          createdAt: e.createdAt,
          metadata: e.metadata,
        };

        // 計算可信度、及時性
        source.credibility = computeCredibility(source);
        source.timeliness = computeTimeliness(source.createdAt);

        allEvidence.push(source);
      }
    }

    // 2. 從 Verification Engine 獲取驗證結果作為證據
    if (this.verificationEngine && query.taskId) {
      try {
        // 這裡需要根據 VerificationEngine 的實際 API 調整
        // 假設有獲取驗證結果的方法
      } catch {
        // 忽略驗證引擎錯誤
      }
    }

    // 3. 過濾類型
    let filteredEvidence = allEvidence;
    if (query.types && query.types.length > 0) {
      filteredEvidence = allEvidence.filter((e) => query.types!.includes(e.type));
    }

    // 4. 去重
    filteredEvidence = deduplicateEvidence(filteredEvidence);

    // 5. 計算加權分數
    for (const e of filteredEvidence) {
      e.score = computeWeightedScore(e, this.weights);
    }

    // 6. 按分數排序
    filteredEvidence.sort((a, b) => b.score - a.score);

    // 7. 限制結果數量
    if (query.maxResults) {
      filteredEvidence = filteredEvidence.slice(0, query.maxResults);
    }

    // 8. 過濾最小分數
    if (query.minScore !== undefined) {
      filteredEvidence = filteredEvidence.filter((e) => e.score >= query.minScore!);
    }

    // 9. 計算總分
    const totalScore = filteredEvidence.length > 0
      ? filteredEvidence.reduce((sum, e) => sum + e.score, 0) / filteredEvidence.length
      : 0;

    return {
      taskId: query.taskId,
      query: query.query,
      evidence: filteredEvidence,
      totalScore,
      passed: totalScore >= EVIDENCE_PASS_THRESHOLD,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 從驗證結果創建證據
   */
  createEvidenceFromVerification(
    taskId: string,
    verifier: string,
    status: string,
    output: string,
    durationMs: number,
  ): EvidenceSource {
    const snippet = output.slice(0, 300);
    return {
      type: "code_execution",
      id: `${taskId}:${verifier}:${Date.now()}`,
      title: `Verification: ${verifier} (${status})`,
      snippet,
      fullContent: output,
      credibility: 1.0, // 代碼執行結果完全可信
      relevance: status === "PASS" ? 1.0 : 0.5,
      timeliness: 1.0,
      score: 0,
      accessedAt: new Date().toISOString(),
      metadata: {
        verifier,
        status,
        durationMs,
        taskId,
      },
    };
  }

  /**
   * 從文檔創建證據
   */
  createEvidenceFromDocumentation(
    id: string,
    title: string,
    url: string,
    snippet: string,
    fullContent?: string,
    official = false,
  ): EvidenceSource {
    return {
      type: "documentation",
      id,
      title,
      url,
      snippet,
      fullContent,
      credibility: official ? 0.95 : 0.85,
      relevance: 0.8,
      timeliness: 0.8,
      score: 0,
      accessedAt: new Date().toISOString(),
      metadata: { official },
    };
  }

  /**
   * 從外部 API 創建證據
   */
  createEvidenceFromExternalApi(
    id: string,
    title: string,
    url: string,
    snippet: string,
    fullContent?: string,
  ): EvidenceSource {
    return {
      type: "external_api",
      id,
      title,
      url,
      snippet,
      fullContent,
      credibility: 0.7,
      relevance: 0.7,
      timeliness: 0.9,
      score: 0,
      accessedAt: new Date().toISOString(),
      metadata: { apiUrl: url },
    };
  }

  /**
   * 獲取當前權重配置
   */
  getWeights(): EvidenceScoringWeights {
    return { ...this.weights };
  }

  /**
   * 更新權重配置
   */
  updateWeights(weights: Partial<EvidenceScoringWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }
}

export function createEvidenceModel(opts: { weights?: Partial<EvidenceScoringWeights> } = {}): EvidenceModel {
  return new EvidenceModel(opts);
}