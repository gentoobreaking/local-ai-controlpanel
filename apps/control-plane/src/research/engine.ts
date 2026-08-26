// Research Engine（Spec §11）
//
// 實作文獻檢索、證據收集與分析：
// - Query Expansion：關鍵字擴展、同義詞匹配
// - 3-gram 相似度匹配（復用 MemoryRetriever/StyleKB 的向量基礎設施）
// - 證據收集：來源標記、可信度評分、去重
// - 連接 Memory Retriever（專案記憶）+ StyleKB（跨專案知識庫）
// - 多層 MCP Server 整合：tw-quant-mcp (Primary) → yfinance-mcp (Backup) → FinMind-MCP (2nd Backup)

import { ngramVector, cosineSim } from "../rag/style-kb.js";
import type {
  ResearchQuery,
  EvidenceSource,
  ResearchResult,
  ResearchEngineOptions,
} from "./types.js";
import type { McpServer } from "../mcp/server.js";

export type { EvidenceSource, ResearchQuery, ResearchResult, ResearchEngineOptions };

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_AGE_DAYS = 30;
const CONFIDENCE_THRESHOLD = 0.3;

export type McpServerName = "tw-quant-mcp" | "yfinance-mcp" | "finmind-mcp";

export interface McpServerRegistry {
  get(name: McpServerName): McpServer | undefined;
  has(name: McpServerName): boolean;
}

export function createMcpServerRegistry(servers: Map<string, McpServer>): McpServerRegistry {
  return {
    get(name: McpServerName) {
      return servers.get(name);
    },
    has(name: McpServerName) {
      return servers.has(name);
    },
  };
}

export function selectMcpServer(query: string, symbol?: string): McpServerName {
  // 台股代碼格式：4-5 位數字，或已知台股名稱
  const isTaiwanStock = symbol?.match(/^\d{4,5}$/) ||
    ["台積電", "聯發科", "鴻海", "台塑", "聯電", "南亞科", "大立光", "瑞昱", "矽品", "世界先進"]
      .some(n => query.includes(n));
  
  if (isTaiwanStock) return "tw-quant-mcp";  // Primary
  
  // 含美股/ETF/全球關鍵字
  if (query.match(/\b(AAPL|TSLA|SPY|QQQ|GOOGL|MSFT|AMZN|META|NVDA|NASDAQ|NYSE|ETF|美股|美國)\b/i)) {
    return "yfinance-mcp";
  }
  
  return "tw-quant-mcp";  // 預設優先用 tw-quant-mcp
}

async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // 這裡需要根據實際的 McpServer API 調整
  // 假設有 callTool 方法或類似的介面
  if (typeof (server as any).callTool === "function") {
    return (server as any).callTool(toolName, args);
  }
  // 如果是透過 stdio 子進程，可能需要透過其他方式調用
  // 這裡先返回空結果，實際整合時根據 McpServer 實作調整
  console.warn(`MCP tool call not implemented for ${toolName}`);
  return null;
}

export async function searchViaMcp(
  registry: McpServerRegistry,
  query: string,
  symbol?: string,
  preferredServer?: McpServerName
): Promise<EvidenceSource[]> {
  const allServers: McpServerName[] = ["tw-quant-mcp", "yfinance-mcp", "finmind-mcp"];
  const serversToTry: McpServerName[] = preferredServer
    ? [preferredServer, ...allServers.filter(s => s !== preferredServer)]
    : allServers;

  for (const serverName of serversToTry) {
    const server = registry.get(serverName);
    if (!server) continue;

    try {
      // 嘗試呼叫對應的搜尋工具
      let toolName = "search";
      let args: Record<string, unknown> = { query };
      
      if (serverName === "tw-quant-mcp") {
        toolName = "get_stock_trend_composite";
        args = { symbol: symbol || query, horizon: "mid" };
      } else if (serverName === "yfinance-mcp") {
        toolName = "yfinance_get_ticker_info";
        args = { symbol: symbol || query };
      } else if (serverName === "finmind-mcp") {
        toolName = "get_stock_price";
        args = { stock_id: symbol || query };
      }

      const result = await callMcpTool(server, toolName, args);
      if (result) {
        // 將結果轉換為 EvidenceSource
        return [{
          type: "external",
          id: `${serverName}:${Date.now()}`,
          title: `${serverName}: ${toolName}`,
          snippet: JSON.stringify(result).slice(0, 500),
          confidence: 0.8,
          createdAt: new Date().toISOString(),
          metadata: { server: serverName, tool: toolName, raw: result },
        }];
      }
    } catch (e) {
      console.warn(`MCP server ${serverName} failed:`, e);
      continue; // 嘗試下一個
    }
  }
  return [];
}

export function queryExpansion(query: string): string[] {
  const base = query.toLowerCase().trim();
  const expansions = new Set<string>([base]);

  const synonyms: Record<string, string[]> = {
    "lint": ["linting", "style", "formatter", "flake8", "eslint", "pylint"],
    "type": ["typing", "type hint", "type annotation", "mypy", "tsc"],
    "import": ["imports", "module", "dependency", "require", "from"],
    "syntax": ["parse", "parsing", "syntax error", "parser"],
    "undefined": ["not defined", "reference error", "undeclared"],
    "unused": ["dead code", "unreferenced", "unreferenced variable"],
    "format": ["formatting", "indentation", "whitespace", "prettier", "black"],
    "test": ["testing", "unit test", "pytest", "jest", "vitest"],
    "build": ["compile", "compilation", "bundling", "webpack", "vite"],
    "deploy": ["deployment", "ci/cd", "pipeline", "release"],
  };

  for (const [key, vals] of Object.entries(synonyms)) {
    if (base.includes(key)) {
      for (const v of vals) expansions.add(v);
    }
  }

  const words = base.split(/\s+/).filter((w) => w.length > 2);
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      expansions.add(`${words[i]} ${words[j]}`);
    }
  }

  return [...expansions];
}

export function computeCredibility(source: EvidenceSource): number {
  let score = source.confidence;

  switch (source.type) {
    case "memory":
      score *= 0.9;
      break;
    case "style-kb":
      score *= 0.85;
      break;
    case "external":
      score *= 0.7;
      break;
  }

  return Math.min(1, Math.max(0, score));
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

export class ResearchEngine {
  private memoryRetriever: any;
  private styleKb: any;
  private externalSearch?: (query: string) => Promise<EvidenceSource[]>;

  constructor(opts: ResearchEngineOptions = {}) {
    this.memoryRetriever = opts.memoryRetriever;
    this.styleKb = opts.styleKb;
    this.externalSearch = opts.externalSearch;
  }

  async research(query: ResearchQuery): Promise<ResearchResult> {
    const { taskId, query: queryText, language, errorType, project, topK = DEFAULT_TOP_K, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = query;
    const expandedQueries = queryExpansion(queryText);

    const allEvidence: EvidenceSource[] = [];

    if (this.memoryRetriever && taskId) {
      const resolvedProject = project ?? this.extractProjectFromTaskId(taskId);
      if (resolvedProject) {
        for (const q of expandedQueries.slice(0, 3)) {
          const memories = this.memoryRetriever.retrieveMemory({
            project: resolvedProject,
            query: q,
            topK: Math.max(1, Math.floor(topK / 2)),
            threshold: CONFIDENCE_THRESHOLD,
            tags: language ? [language] : undefined,
          });
          for (const m of memories) {
            allEvidence.push({
              type: "memory",
              id: m.record.id,
              title: `Project Memory: ${m.record.key}`,
              snippet: m.record.value.slice(0, 300),
              confidence: m.score,
              createdAt: m.record.createdAt,
              metadata: { key: m.record.key, tags: m.record.tags, project: m.record.project },
            });
          }
        }
      }
    }

    if (this.styleKb) {
      for (const q of expandedQueries.slice(0, 3)) {
        const cases = this.styleKb.search({
          language: language ?? "unknown",
          errorType,
          snippet: q,
          topK: Math.max(1, Math.floor(topK / 2)),
          maxAgeDays,
        });
        for (const c of cases) {
          allEvidence.push({
            type: "style-kb",
            id: c.id,
            title: `Style KB: ${c.errorType} (${c.language})`,
            snippet: `${c.errorSnippet.slice(0, 200)}\n---\n${c.fixedDiff.slice(0, 200)}`,
            confidence: 0.8,
            createdAt: c.createdAt,
            metadata: { errorType: c.errorType, language: c.language, isFewShot: c.isFewShot },
          });
        }
      }
    }

    if (this.externalSearch) {
      for (const q of expandedQueries.slice(0, 2)) {
        try {
          const external = await this.externalSearch(q);
          allEvidence.push(...external);
        } catch {
          // ignore external search failures
        }
      }
    }

    const uniqueEvidence = deduplicateEvidence(allEvidence);
    const scoredEvidence = uniqueEvidence
      .map((e) => ({ ...e, confidence: computeCredibility(e) }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, topK);

    const avgConfidence = scoredEvidence.length > 0
      ? scoredEvidence.reduce((sum, e) => sum + e.confidence, 0) / scoredEvidence.length
      : 0;

    const summary = this.generateSummary(queryText, scoredEvidence);

    return {
      taskId,
      query: queryText,
      evidence: scoredEvidence,
      summary,
      confidence: avgConfidence,
      timestamp: new Date().toISOString(),
    };
  }

  private extractProjectFromTaskId(taskId: string): string | undefined {
    const parts = taskId.split("-");
    return parts.length > 0 ? parts[0] : undefined;
  }

  private generateSummary(query: string, evidence: EvidenceSource[]): string {
    if (evidence.length === 0) {
      return `未找到與 "${query}" 相關的證據。建議擴大搜尋範圍或檢查專案配置。`;
    }

    const sources = new Set(evidence.map((e) => e.type));
    const sourceLabels = Array.from(sources).map((s) =>
      s === "memory" ? "專案記憶" : s === "style-kb" ? "風格知識庫" : "外部來源"
    ).join("、");

    const topEvidence = evidence[0]!;
    const preview = topEvidence.snippet.slice(0, 150).replace(/\n/g, " ");

    return `找到 ${evidence.length} 條證據（來源：${sourceLabels}）。最高相關度：${(topEvidence.confidence * 100).toFixed(0)}% — ${preview}...`;
  }
}

export function createResearchEngine(opts: ResearchEngineOptions = {}): ResearchEngine {
  return new ResearchEngine(opts);
}