// Control Plane 執行設定（spec §30 / §45.3）。
// API 只 bind 127.0.0.1——不開放外部網路。

import { fileURLToPath } from "node:url";

/** monorepo root（apps/control-plane/src → ../../..） */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface ProtocolConfig {
  /** §18 MCP Layer 開關（Phase 6+ 啟用；預設關閉） */
  mcp: { enabled: boolean; workspace: string };
  /** §19 ACP-Protocol Layer 開關（Phase 6+ 啟用；預設關閉） */
  acp: { enabled: boolean };
  /** MCP Server 多層備援設定 */
  mcpServers: {
    /** Primary: tw-quant-mcp (本機 Go 執行檔) */
    twQuant: { enabled: boolean; path: string };
    /** Backup: yfinance-mcp (PyPI) */
    yfinance: { enabled: boolean };
    /** 2nd Backup: FinMind-MCP (PyPI，需 FINMIND_TOKEN) */
    finmind: { enabled: boolean };
    /** 研究層：GitHub 官方 MCP（repo/code search、README；需 GITHUB_TOKEN） */
    github: {
      enabled: boolean;
      transport: "docker" | "binary" | "remote";
      remoteUrl?: string;
    };
    /** 研究層：Scrapling MCP（網頁抓取→Markdown、反反爬；pip install "scrapling[ai]"） */
    scrapling: { enabled: boolean; command: string };
  };
}

export interface ExecutionConfig {
  /** §25 Phase 設定：1-5 | 6 | 7 | 8 | 9 | 10 | 11（預設 1，Phase 1–5 local_only） */
  phase: number;
  /** 是否允許 Cloud（Phase 9+ 才生效） */
  allowCloud: boolean;
  /** Agentic 搜尋迴圈：IMPLEMENTING 前讓模型自評缺口並迭代查詢（§16 延伸） */
  agenticSearch: boolean;
  /** 搜尋迴圈硬上限（防無限燒 token） */
  maxSearchRounds: number;
  maxDailyCostUsd?: number;
  /** Cloud token 上限（per task） */
  maxTokensPerTask?: number;
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  /** policies/*.yaml 所在目錄（§30）；預設 monorepo root 的 policies/。 */
  policiesDir: string;
  /** §18/§19：協議層設定（Phase 1–5 預設 disabled）。 */
  protocol: ProtocolConfig;
  /** §25：Execution 階段設定（Phase 9+ 啟用 Hybrid/Cloud）。 */
  execution: ExecutionConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.CP_HOST ?? "127.0.0.1",
    port: Number(env.CP_PORT ?? 3001),
    dataDir: env.CP_DATA_DIR ?? "./.acp-data",
    policiesDir: env.CP_POLICIES_DIR ?? `${REPO_ROOT}policies`,
    protocol: {
      mcp: {
        enabled: env.CP_MCP_ENABLED === "1" || env.CP_MCP_ENABLED === "true",
        workspace: env.CP_MCP_WORKSPACE ?? env.CP_WORKSPACE ?? process.cwd(),
      },
      acp: {
        enabled: env.CP_ACP_ENABLED === "1" || env.CP_ACP_ENABLED === "true",
      },
      mcpServers: {
        twQuant: {
          enabled: env.CP_MCP_TW_QUANT_ENABLED !== "0" && env.CP_MCP_TW_QUANT_ENABLED !== "false",
          path: env.CP_MCP_TW_QUANT_PATH ?? `${REPO_ROOT}../tw-quant-mcp/bin/tw-quant-mcp`,
        },
        yfinance: {
          enabled: env.CP_MCP_YFINANCE_ENABLED !== "0" && env.CP_MCP_YFINANCE_ENABLED !== "false",
        },
        finmind: {
          enabled: env.CP_MCP_FINMIND_ENABLED === "1" || env.CP_MCP_FINMIND_ENABLED === "true",
        },
        github: {
          enabled: env.CP_MCP_GITHUB_ENABLED !== "0" && env.CP_MCP_GITHUB_ENABLED !== "false",
          transport: (env.CP_MCP_GITHUB_TRANSPORT as "docker" | "binary" | "remote") ?? "docker",
          remoteUrl: env.CP_MCP_GITHUB_REMOTE_URL,
        },
        scrapling: {
          enabled: env.CP_MCP_SCRAPLING_ENABLED === "1" || env.CP_MCP_SCRAPLING_ENABLED === "true",
          command: env.CP_MCP_SCRAPLING_CMD ?? "scrapling-mcp",
        },
      },
    },
    execution: {
      phase: Number(env.CP_PHASE ?? 1),
      allowCloud: env.CP_ALLOW_CLOUD === "1" || env.CP_ALLOW_CLOUD === "true",
      agenticSearch: env.CP_AGENTIC_SEARCH !== "0" && env.CP_AGENTIC_SEARCH !== "false",
      maxSearchRounds: Math.max(1, Number(env.CP_MAX_SEARCH_ROUNDS ?? 10)),
      maxDailyCostUsd: env.CP_MAX_DAILY_COST_USD ? Number(env.CP_MAX_DAILY_COST_USD) : undefined,
      maxTokensPerTask: env.CP_MAX_TOKENS_PER_TASK ? Number(env.CP_MAX_TOKENS_PER_TASK) : undefined,
    },
  };
}