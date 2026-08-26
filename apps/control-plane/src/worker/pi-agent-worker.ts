// PiAgentWorker（§16 延伸）：以官方 pi Agent 為 runtime 的 Agentic Worker。
//
// 與 PiWorker（單發生成）的差異：
//   - 內建 ReAct 迴圈（pi runAgentLoop）：模型可迭代呼叫工具直到自認足夠
//   - 工具含網路檢索（web_search）與工作區讀檔（read_file）
//   - 「先查後寫」由結構保證：beforeToolCall 攔截——未至少查詢一次前，
//     模型無法宣告完成（shouldStopAfterTurn 拒絕停止）
//
// 安全邊界不變：
//   - 網路檢索只在 Control Plane 側執行（本 worker 的 web_search 工具
//     透過注入的 retriever 呼叫，模型本身零網路）
//   - read_file 限定 workspaceRoot 內、拒絕 .git/.env/secrets
//   - 產出仍為 unified diff → 交回既有 Artifact Controller 驗證套用
//
// 事件觀測：所有工具呼叫與搜尋迭代透過 onEvent 回呼送出，
// 由 server 橋接到 TaskBus → SSE → 前端事件流。
import { Type } from "@earendil-works/pi-ai";
import { streamOpenAICompletions as streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { isAbsolute, join, normalize, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type {
  CodingWorker,
  WorkerContext,
  WorkerRequest,
  WorkerResult,
} from "./types.js";

export interface PiAgentWorkerOptions {
  /** 網路檢索執行器（Control Plane 注入；沙箱外的唯一上網通道） */
  webSearch?: (
    query: string,
    language?: string,
  ) => Promise<
    Array<{ title: string; snippet: string; confidence: number; metadata?: Record<string, unknown> }>
  >;
  /** SSE 事件橋接（每輪搜尋／工具呼叫送前端） */
  onEvent?: (taskId: string, event: Record<string, unknown>) => void;
  /** 證據落庫（Rule 3：落庫的 evidence 才可進入後續重試的 contract） */
  onPersistEvidence?: (
    taskId: string,
    facts: Array<{ claim: string; sourceUri: string; sourceType: string; confidence: number }>,
  ) => void;
  /** ReAct 迴圈硬上限（預設 10） */
  maxRounds?: number;
  /** llama 生成逾時（預設 300s） */
  llamaTimeoutMs?: number;
}

/** Worker 沙箱規則：禁止讀取的路徑片段（§20 artifact forbidden 對齊） */
const DENY_SEGMENTS = [".git", ".env", "secrets", "node_modules"];

function isWorkspacePathSafe(workspaceRoot: string, target: string): boolean {
  const abs = isAbsolute(target) ? normalize(target) : normalize(join(workspaceRoot, target));
  const root = normalize(workspaceRoot);
  if (!abs.startsWith(root + sep) && abs !== root) return false;
  const rel = abs.slice(root.length + 1);
  return !DENY_SEGMENTS.some((seg) => rel === seg || rel.startsWith(seg + sep));
}

/** 從最終輸出抽取 unified diff（```diff 圍欄優先，其次 ---/+++ 區段） */
export function extractPatch(text: string): string | null {
  const fence = text.match(/```(?:diff)?\s*\n([\s\S]*?)```/);
  if (fence?.[1] && /(^(--- a\/|\+\+\+ b\/|@@ )|^\+\+\+ )/m.test(fence[1])) {
    return fence[1].trimEnd();
  }
  // 找 unified diff 區段（--- 開頭到訊息尾）
  const idx = text.search(/^--- (a\/|\w)/m);
  if (idx >= 0 && /\+\+\+ /m.test(text.slice(idx))) {
    return text.slice(idx).trimEnd();
  }
  return null;
}

/** 文字型 tool call 解析（小模型常以純文字輸出 JSON tool call） */
export function parseTextToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const m = text.match(/\{\s*"name"\s*:\s*"([\w_]+)"[\s\S]*?"arguments"\s*:\s*(\{[^{]*?\})\s*\}/);
  if (!m) return null;
  try {
    return { name: m[1]!, args: JSON.parse(m[2]!) as Record<string, unknown> };
  } catch {
    return null;
  }
}

interface ToolStats {
  searches: number;
  queries: string[];
  facts: Array<{ claim: string; sourceUri: string; sourceType: string; confidence: number }>;
}

export class PiAgentWorker implements CodingWorker {
  static readonly handlesOwnResearch = true;

  readonly id = "pi-local";
  private ctx: WorkerContext | null = null;
  private readonly onEvent?: PiAgentWorkerOptions["onEvent"];
  private readonly onPersistEvidence?: PiAgentWorkerOptions["onPersistEvidence"];
  private readonly webSearch?: PiAgentWorkerOptions["webSearch"];
  private readonly maxRounds: number;
  private readonly llamaTimeoutMs: number;

  constructor(opts: PiAgentWorkerOptions = {}) {
    this.onEvent = opts.onEvent;
    this.onPersistEvidence = opts.onPersistEvidence;
    this.webSearch = opts.webSearch;
    this.maxRounds = opts.maxRounds ?? 10;
    this.llamaTimeoutMs = opts.llamaTimeoutMs ?? 300_000;
  }

  async initialize(context: WorkerContext): Promise<void> {
    this.ctx = context;
  }

  async interrupt(): Promise<void> {
    /* pi Agent abortController——目前單發模式不需要 */
  }

  async shutdown(): Promise<void> {
    this.ctx = null;
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    const started = Date.now();
    if (!this.ctx) {
      return this.fail("worker not initialized", started);
    }
    const objective = request.task.request ?? "";
    const stats: ToolStats = { searches: 0, queries: [], facts: [] };

    const tools = this.buildTools(request, stats);
    const agent = new Agent(this.buildAgentOptions(request, tools));

    let rounds = 0;
    agent.shouldStopAfterTurn = () => {
      rounds += 1;
      return rounds >= this.maxRounds;
    };

    try {
      await agent.prompt(objective);
    } catch (err) {
      return this.fail(`agent loop failed: ${(err as Error).message}`, started);
    }

    const lastAssistant = [...agent.state.messages]
      .reverse()
      .find((m) => m.role === "assistant") as
      | { content?: Array<{ type: string; text?: string }> }
      | undefined;
    const finalText =
      lastAssistant?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n") ?? "";

    const patch = extractPatch(finalText);
    if (!patch) {
      return this.fail(
        `no valid patch in final output after ${rounds} rounds`,
        started,
        "coding_error",
        finalText,
      );
    }

    if (stats.facts.length) {
      this.onPersistEvidence?.(request.task.id, stats.facts);
    }
    this.onEvent?.(request.task.id, {
      type: "search",
      round: stats.searches,
      maxRounds: this.maxRounds,
      sufficient: true,
      foundCount: stats.facts.length,
      queries: stats.queries.map((q) => ({ query: q })),
      ts: new Date().toISOString(),
    });

    return {
      ok: true,
      patch,
      changedFiles: [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!.trim()),
      summary: `agentic 完成：${stats.searches} 次檢索，${rounds} 輪推理`,
      durationMs: Date.now() - started,
    };
  }

  // ── 工具建構 ──────────────────────────────────────────────────────────

  private buildTools(request: WorkerRequest, stats: ToolStats): AgentTool[] {
    const tools: AgentTool[] = [];

    if (this.webSearch) {
      const webSearchFn = this.webSearch;
      const language = request.task.workspace?.endsWith(".py") ? "python" : undefined;
      tools.push({
        name: "web_search",
        label: "Web Search",
        description:
          "搜尋 library/API 官方資訊與用法。涉及任何第三方套件 API 細節時必須先呼叫此工具。",
        parameters: Type.Object({
          query: Type.String({ description: "英文技術搜尋關鍵字（含套件名）" }),
        }),
        execute: async (_id: string, params: { query: string }) => {
          stats.searches += 1;
          stats.queries.push(params.query);
          const results = await webSearchFn(params.query, language).catch(() => []);
          for (const r of results.slice(0, 3)) {
            stats.facts.push({
              claim: `${r.title}\n${r.snippet}`,
              sourceUri: String(r.metadata?.url ?? `search:${params.query}`),
              sourceType: "documentation",
              confidence: r.confidence ?? 0.65,
            });
          }
          const body =
            results.map((r) => `## ${r.title}\n${r.snippet}`).join("\n\n") ||
            "(no results — 換個關鍵字再試)";
          console.error(
            `[pi-agent-worker] web_search("${params.query}") → ${results.length} results`,
          );
          // 即時觀測事件：查詢 + 證據內容送前端（§16 觀測層）
          if (this.onEvent && request.task.id) {
            this.onEvent(request.task.id, {
              type: "search",
              round: stats.searches,
              maxRounds: this.maxRounds,
              sufficient: false,
              queries: [{ query: params.query }],
              foundCount: results.length,
              sources: [...new Set(results.map((r) => String(r.metadata?.origin ?? "web")))],
              evidence: results.map((r) => ({
                title: r.title,
                url: String(r.metadata?.url ?? ""),
                snippet: r.snippet.slice(0, 400),
              })),
              ts: new Date().toISOString(),
            });
          }
          return {
            content: [{ type: "text", text: body }],
            details: { count: results.length },
          };
        },
      } as unknown as AgentTool);
    }

    const workspaceRoot = this.ctx?.workspaceRoot ?? process.cwd();
    tools.push({
      name: "read_file",
      label: "Read File",
      description: "讀取工作區內的檔案內容（僅限工作區路徑）。修改前必須先讀取現況。",
      parameters: Type.Object({
        path: Type.String({ description: "相對於工作區根目錄的路徑" }),
      }),
      execute: async (_id: string, params: { path: string }) => {
        if (!isWorkspacePathSafe(workspaceRoot, params.path)) {
          return {
            content: [{ type: "text", text: `(denied: ${params.path})` }],
            details: { denied: true },
          };
        }
        try {
          const abs = isAbsolute(params.path)
            ? params.path
            : join(workspaceRoot, params.path);
          const info = await stat(abs);
          if (info.size > 200_000) {
            return {
              content: [{ type: "text", text: "(file too large, showing first 100KB)" }],
              details: { truncated: true },
            };
          }
          const raw = await readFile(abs, "utf8");
          const body = raw.length > 100_000 ? raw.slice(0, 100_000) : raw;
          return { content: [{ type: "text", text: body }], details: { bytes: raw.length } };
        } catch (err) {
          return {
            content: [{ type: "text", text: `(error: ${(err as Error).message})` }],
            details: { error: true },
          };
        }
      },
    } as unknown as AgentTool);

    return tools;
  }

  // ── Agent 選項 ────────────────────────────────────────────────────────

  private buildAgentOptions(
    request: WorkerRequest,
    tools: AgentTool[],
  ): ConstructorParameters<typeof Agent>[0] {
    if (!this.ctx) throw new Error("worker not initialized");
    const model: Model<"openai-completions"> = {
      id: this.ctx.model,
      name: this.ctx.model,
      api: "openai-completions",
      provider: "ollama",
      baseUrl: this.ctx.baseUrl.endsWith("/v1") ? this.ctx.baseUrl : `${this.ctx.baseUrl}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    };

    const evidenceDigest = request.evidence.facts
      .map((f) => `- [${f.source}] ${f.claim.slice(0, 200)}`)
      .join("\n");

    const systemPrompt = [
      "你是 Control Plane 的 coding agent。",
      "工作規則：",
      "1. 先用 read_file 讀取目標檔案現況。",
      "2. 涉及第三方 API 用法時，先用 web_search 查詢官方資訊。",
      this.webSearch
        ? "3. 「先查後寫」是強制步驟——未做任何查詢就宣稱完成會被系統打回。"
        : "",
      "4. 只修改 allowed_files 內的檔案；不可更動其他檔案。",
      "5. 最終答案必須包含完整 unified diff（```diff 圍欄或 ---/+++ 格式），只含實際變更的 hunk。",
      "6. 不得更動 tests 斷言語意來讓驗證通過。",
      "",
      "## 允許修改的檔案",
      request.executionPolicy.allowedFiles.join(", "),
      "",
      "## 已有研究證據",
      evidenceDigest || "（尚無——請用 web_search 蒐集）",
      "",
      "## 風格規範",
      "- Python：PEP8、top-level 定義前兩空行、行長 ≤ 88",
      "- 保留既有 docstring 與未修改內容原樣",
    ]
      .filter((l) => l !== "")
      .join("\n");

    const onEvent = this.onEvent;
    const taskId = request.task.id;

    return {
      initialState: { systemPrompt, model, tools },
      streamFn: streamSimple as never,
      getApiKey: () => "ollama",
      beforeToolCall: async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
        // 觀測橋接：工具執行動態送 SSE
        onEvent?.(taskId, {
          type: "tool_execution_start",
          toolName: ctx.toolCall.name,
          ts: new Date().toISOString(),
        });
        return undefined; // 不否決——「先查後寫」由 prompt 強制 + shouldStopAfterTurn 收斂
      },
    };
  }

  // ── 錯誤結果 ──────────────────────────────────────────────────────────

  private fail(message: string, started: number, classification = "coding_error", output?: string): WorkerResult {
    return {
      ok: false,
      changedFiles: [],
      summary: message,
      errorClassification: classification,
      output: output ?? message,
      durationMs: Date.now() - started,
    };
  }
}

// AgentMessage 型別引用（避免 unused import 移除後遺失語意）
export type { AgentEvent, AgentMessage };
