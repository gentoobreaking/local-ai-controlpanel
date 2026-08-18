// Evidence Model 類型定義（Spec §13）

/** 證據類型 */
export type EvidenceType = "documentation" | "code_execution" | "external_api" | "memory" | "style_kb";

/** 證據來源 */
export interface EvidenceSource {
  /** 來源類型 */
  type: EvidenceType;
  /** 唯一識別碼 */
  id: string;
  /** 標題/描述 */
  title: string;
  /** 原始出處 URL 或檔案路徑 */
  url?: string;
  /** 內容片段 */
  snippet: string;
  /** 完整內容（可選） */
  fullContent?: string;
  /** 可信度評分 (0.0-1.0) */
  credibility: number;
  /** 相關性評分 (0.0-1.0) */
  relevance: number;
  /** 及時性評分 (0.0-1.0) */
  timeliness: number;
  /** 加權總分 (0.0-1.0) */
  score: number;
  /** 存取時間 */
  accessedAt: string;
  /** 建立/發布時間 */
  createdAt?: string;
  /** 元數據 */
  metadata?: Record<string, unknown>;
}

/** 證據收集查詢 */
export interface EvidenceQuery {
  taskId: string;
  query: string;
  types?: EvidenceType[];
  minScore?: number;
  maxResults?: number;
}

/** 證據收集結果 */
export interface EvidenceResult {
  taskId: string;
  query: string;
  evidence: EvidenceSource[];
  totalScore: number;
  passed: boolean;
  timestamp: string;
}

/** 證據評分權重配置 */
export interface EvidenceScoringWeights {
  /** 文獻類型權重 */
  documentation: number;
  /** 代碼執行結果權重 */
  code_execution: number;
  /** 外部 API 響應權重 */
  external_api: number;
  /** 專案記憶權重 */
  memory: number;
  /** 風格知識庫權重 */
  style_kb: number;
}

/** 預設評分權重 */
export const DEFAULT_EVIDENCE_WEIGHTS: EvidenceScoringWeights = {
  documentation: 1.0,
  code_execution: 1.0,
  external_api: 0.8,
  memory: 0.9,
  style_kb: 0.85,
};

/** 證據通過門檻 */
export const EVIDENCE_PASS_THRESHOLD = 0.7;

/** 證據最小評分 */
export const MIN_EVIDENCE_SCORE = 0.0;

/** 證據最高評分 */
export const MAX_EVIDENCE_SCORE = 1.0;