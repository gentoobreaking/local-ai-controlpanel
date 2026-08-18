// Research Engine 類型定義（Spec §11）

export interface ResearchQuery {
  taskId: string;
  query: string;
  language?: string;
  errorType?: string;
  topK?: number;
  maxAgeDays?: number;
}

export interface EvidenceSource {
  type: "memory" | "style-kb" | "external";
  id: string;
  title: string;
  url?: string;
  snippet: string;
  confidence: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchResult {
  taskId: string;
  query: string;
  evidence: EvidenceSource[];
  summary: string;
  confidence: number;
  timestamp: string;
}

export interface ResearchEngineOptions {
  memoryRetriever?: any;
  styleKb?: any;
  externalSearch?: (query: string) => Promise<EvidenceSource[]>;
}