// PiAgentWorker（§16 延伸）：以官方 pi Agent 為 runtime 的 Agentic Worker。
//
// 與 PiWorker（單發生成）的差異：
//   - 內建 ReAct 迴圈（pi Agent）：模型可迭代呼叫工具直到自認足夠
//   - 工具含網路檢索（web_search）、讀檔（read_file）、寫檔（write）、編輯（edit）
//   - 「先查後寫」由 beforeToolCall 強制執行——未至少查詢一次前，
//     write/edit 工具會被拒絕（policy rejection，非程式碼錯誤）
//   - beforeToolCall 同時執行「read-before-modify」檢查：
//     write/edit 必須在同檔案路徑下至少呼叫過一次 read_file，否則拒絕
//
// 安全邊界不變：
//   - 網路檢索只在 Control Plane 側執行（本 worker 的 web_search 工具
//     透過注入的 retriever 呼叫，模型本身零網路）
//   - read_file/write/edit 限定 workspaceRoot 內、拒絕 .git/.env/secrets/node_modules
//   - 產出仍為 unified diff → 交回既有 Artifact Controller 驗證套用
//
// 事件觀測：所有工具呼叫與搜尋迭代透過 onEvent 回呼送前端，
// 由 server 橋接到 TaskBus → SSE → 前端事件流。

import { Type } from "@earendil-works/pi-ai";
import { streamOpenAICompletions as streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { isAbsolute, join, normalize, sep } from "node:path";
import { readFile, stat, writeFile, mkdir, access, constants, readdir } from "node:fs/promises";
import {
  Agent,
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

// ── Constants ─────────────────────────────────────────────────────────────

/** Worker 沙箱規則：禁止存取的路徑片段（§20 artifact forbidden 對齊） */
const DENY_SEGMENTS = [".git", ".env", "secrets", "node_modules"];

/** read tool 預設限制 */
const DEFAULT_MAX_BYTES = 25_000;
const DEFAULT_MAX_LINES = 800;

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * 檢查目標路徑是否在工作區內且不含禁止段。
 */
function isWorkspacePathSafe(workspaceRoot: string, target: string): boolean {
  const abs = isAbsolute(target) ? normalize(target) : normalize(join(workspaceRoot, target));
  const root = normalize(workspaceRoot);
  if (!abs.startsWith(root + sep) && abs !== root) return false;
  const rel = abs.slice(root.length + 1);
  return !DENY_SEGMENTS.some((seg) => rel === seg || rel.startsWith(seg + sep));
}

/**
 * 路徑清理與規一化（處理 unicode 空格、@ 前綴）。
 */
function normalizeToolPath(path: string): string {
  const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  const normalized = path.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * 解析工作區相對路徑為絕對路徑。
 */
async function resolveToolPath(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<string> {
  const normalized = normalizeToolPath(path);
  return isAbsolute(normalized) ? normalize(normalized) : normalize(join(workspaceRoot, normalized));
}

/**
 * 檢查路徑是否存在。
 */
async function pathExists(abs: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  try {
    await access(abs, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析讀取路徑（嘗試多種 unicode 變體）。
 */
async function resolveReadToolPath(
  workspaceRoot: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const resolved = await resolveToolPath(workspaceRoot, path, signal);
  const NARROW_NO_BREAK_SPACE = "\u202F";
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];

  for (const variant of new Set(variants)) {
    if (await pathExists(variant, signal)) return variant;
  }
  return resolved;
}

/**
 * 格式化檔案大小。
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 截斷內容至指定行數/位元組。
 */
function truncateHead(content: string, maxBytes: number, maxLines: number): { content: string; truncated: TruncationResult | undefined } {
  const lines = content.split("\n");
  const originalBytes = Buffer.byteLength(content, "utf8");
  const originalLines = lines.length;

  let result = content;
  let truncatedLines = false;
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join("\n");
    truncatedLines = true;
  }

  let truncatedBytes = false;
  const buf = Buffer.from(result, "utf8");
  if (buf.length > maxBytes) {
    result = buf.subarray(0, maxBytes).toString("utf8");
    truncatedBytes = true;
  }

  if (truncatedLines || truncatedBytes) {
    return {
      content: result,
      truncated: { originalBytes, originalLines, maxBytes, maxLines },
    };
  }
  return { content, truncated: undefined };
}

interface TruncationResult {
  originalBytes: number;
  originalLines: number;
  maxBytes: number;
  maxLines: number;
}

/**
 * 檔案變更佇列 — 防止同一路徑的並行寫入衝突。
 */
class FileMutationQueue {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn());
    this.queues.set(path, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(path) === next) {
        this.queues.delete(path);
      }
    }
  }
}

const mutationQueue = new FileMutationQueue();

// ── Tool Schemas ──────────────────────────────────────────────────────────

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Text to replace" }),
  newText: Type.String({ description: "Replacement text" }),
});

// ── Worker Options ─────────────────────────────────────────────────────────

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

interface ToolStats {
  searches: number;
  queries: string[];
  facts: Array<{ claim: string; sourceUri: string; sourceType: string; confidence: number }>;
  /** 記錄已經讀取過的檔案路徑（for read-before-write policy） */
  readFiles: string[];
}

// ── Patch Extraction ──────────────────────────────────────────────────────

/** 從最終輸出抽取 unified diff（```diff 圓欄優先，其次 ---/+++ 區段） */
export function extractPatch(text: string): string | null {
  const fence = text.match(/```(?:diff)?\s*\n([\s\S]*?)```/);
  if (fence?.[1] && /(^(--- a\/|\+\+\+ b\/|@@ )|^\+\+\+ )/m.test(fence[1])) {
    return fence[1].trimEnd();
  }
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

// ── String utilities ───────────────────────────────────────────────────────

/** Normalize string to LF line endings (also used for edit operations for consistent matching) */
function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// ── PiAgentWorker ─────────────────────────────────────────────────────────

export class PiAgentWorker implements CodingWorker {
  static readonly handlesOwnResearch = true;

  readonly id = "pi-agent";
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
    const stats: ToolStats = { searches: 0, queries: [], facts: [], readFiles: [] };

    const tools = await this.buildTools(request, stats);
    const agent = new Agent(this.buildAgentOptions(request, tools, stats));

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

    // 收集最終助手訊息
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

  private async buildTools(request: WorkerRequest, stats: ToolStats): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];

    // web_search tool
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
          this.onEvent?.(request.task.id, {
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
          return {
            content: [{ type: "text", text: body }],
            details: { count: results.length },
          };
        },
      } as unknown as AgentTool);
    }

    const workspaceRoot = this.ctx?.workspaceRoot ?? process.cwd();

    // read_file tool
    tools.push({
      name: "read_file",
      label: "Read File",
      description: "讀取工作區內的檔案內容（僅限工作區路徑）。修改前必須先讀取現況。",
      parameters: readSchema,
      execute: async (_id: string, params: { path: string; offset?: number; limit?: number }) => {
        const abs = normalizeToolPath(params.path);
        if (!isWorkspacePathSafe(workspaceRoot, abs)) {
          return {
            content: [{ type: "text", text: `(denied: ${params.path})` }],
            details: { denied: true },
          };
        }
        const resolved = await resolveReadToolPath(workspaceRoot, abs);
        try {
          const info = await stat(resolved);
          if (info.isDirectory()) {
            const entries = await readdir(resolved);
            return {
              content: [{ type: "text", text: `Directory: ${resolved}\n${entries.join("\n")}` }],
              details: { isDirectory: true, entries: entries.length },
            };
          }

          const raw = await readFile(resolved, "utf8");
          const { content: body, truncated } = truncateHead(raw, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES);

          // Record that this file has been read (for read-before-write policy)
          if (!stats.readFiles.includes(resolved)) stats.readFiles.push(resolved);
          if (!stats.readFiles.includes(abs)) stats.readFiles.push(abs);

          this.onEvent?.(request.task.id, {
            type: "read_file",
            path: params.path,
            bytes: raw.length,
            lines: body.split("\n").length,
            truncated: !!truncated,
            ts: new Date().toISOString(),
          });

          const header = `// ${params.path} (${formatSize(raw.length)})\n`;
          return {
            content: [{ type: "text", text: header + body }],
            details: { bytes: raw.length, lines: body.split("\n").length, truncated: !!truncated },
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `(error: ${(err as Error).message})` }],
            details: { error: true },
          };
        }
      },
    } as unknown as AgentTool);

    // write tool
    tools.push({
      name: "write",
      label: "Write File",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. Must have read the file first if it already exists.",
      parameters: writeSchema,
      execute: async (_id: string, params: { path: string; content: string }) => {
        const abs = normalizeToolPath(params.path);
        if (!isWorkspacePathSafe(workspaceRoot, abs)) {
          return {
            content: [{ type: "text", text: `(denied: ${params.path})` }],
            details: { denied: true },
          };
        }
        const resolved = isAbsolute(abs) ? normalize(abs) : normalize(join(workspaceRoot, abs));

        // Check read-before-write policy
        const alreadyRead = stats.readFiles.includes(resolved) || stats.readFiles.includes(abs);
        const exists = await pathExists(resolved);
        if (exists && !alreadyRead) {
          this.onEvent?.(request.task.id, {
            type: "policy_violation",
            tool: "write",
            path: params.path,
            reason: "must read file before overwriting",
            ts: new Date().toISOString(),
          });
          return {
            content: [{ type: "text", text: `(policy error: must read file ${params.path} before overwriting it)` }],
            details: { policyViolation: true, reason: "read_before_write" },
          };
        }

        return await mutationQueue.run(resolved, async () => {
          try {
            const dir = normalize(join(resolved, ".."));
            await mkdir(dir, { recursive: true });
            await writeFile(resolved, params.content, "utf8");
            if (!stats.readFiles.includes(resolved)) stats.readFiles.push(resolved);
            if (!stats.readFiles.includes(abs)) stats.readFiles.push(abs);

            this.onEvent?.(request.task.id, {
              type: "write",
              path: params.path,
              bytes: params.content.length,
              ts: new Date().toISOString(),
            });

            return {
              content: [{ type: "text", text: `Successfully wrote ${params.content.length} bytes to ${params.path}` }],
              details: { bytesWritten: params.content.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `(error: ${(err as Error).message})` }],
              details: { error: true },
            };
          }
        });
      },
    } as unknown as AgentTool);

    // edit tool
    tools.push({
      name: "edit",
      label: "Edit File",
      description: "Edit a file by replacing old text with new text. Must have read the file first.",
      parameters: editSchema,
      execute: async (_id: string, params: { path: string; oldText: string; newText: string }) => {
        const abs = normalizeToolPath(params.path);
        if (!isWorkspacePathSafe(workspaceRoot, abs)) {
          return {
            content: [{ type: "text", text: `(denied: ${params.path})` }],
            details: { denied: true },
          };
        }
        const resolved = isAbsolute(abs) ? normalize(abs) : normalize(join(workspaceRoot, abs));

        // Check read-before-edit policy
        const alreadyRead = stats.readFiles.includes(resolved) || stats.readFiles.includes(abs);
        const exists = await pathExists(resolved);
        if (exists && !alreadyRead) {
          this.onEvent?.(request.task.id, {
            type: "policy_violation",
            tool: "edit",
            path: params.path,
            reason: "must read file before editing",
            ts: new Date().toISOString(),
          });
          return {
            content: [{ type: "text", text: `(policy error: must read file ${params.path} before editing it)` }],
            details: { policyViolation: true, reason: "read_before_write" },
          };
        }

        return await mutationQueue.run(resolved, async () => {
          try {
            if (!exists) {
              return {
                content: [{ type: "text", text: `(error: file does not exist: ${params.path})` }],
                details: { error: true, exists: false },
              };
            }

            const raw = await readFile(resolved, "utf8");
            const normalizedOld = normalizeToLF(params.oldText);
            const normalizedContent = normalizeToLF(raw);

            const idx = normalizedContent.indexOf(normalizedOld);
            if (idx < 0) {
              return {
                content: [{ type: "text", text: `(error: old text not found in ${params.path})` }],
                details: { error: true, oldTextNotFound: true },
              };
            }

            const newContent =
              normalizedContent.slice(0, idx) +
              normalizeToLF(params.newText) +
              normalizedContent.slice(idx + normalizedOld.length);

            await writeFile(resolved, newContent, "utf8");
            if (!stats.readFiles.includes(resolved)) stats.readFiles.push(resolved);
            if (!stats.readFiles.includes(abs)) stats.readFiles.push(abs);

            this.onEvent?.(request.task.id, {
              type: "edit",
              path: params.path,
              bytes: params.newText.length,
              ts: new Date().toISOString(),
            });

            return {
              content: [{ type: "text", text: `Successfully edited ${params.path}` }],
              details: { bytesChanged: params.newText.length },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `(error: ${(err as Error).message})` }],
              details: { error: true },
            };
          }
        });
      },
    } as unknown as AgentTool);

    return tools;
  }

  // ── Agent 選項 ────────────────────────────────────────────────────────

  private buildAgentOptions(
    request: WorkerRequest,
    tools: AgentTool[],
    stats: ToolStats,
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
      "5. 最終答案必須包含完整 unified diff（```diff 圓欄或 ---/+++ 格式），只含實際變更的 hunk。",
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
    const webSearchExists = !!this.webSearch;

    return {
      initialState: { systemPrompt, model, tools },
      streamFn: streamSimple as never,
      getApiKey: () => "ollama",
      beforeToolCall: async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
        const toolName = ctx.toolCall.name;

        // 觀測橋接：工具執行動態送 SSE
        onEvent?.(taskId, {
          type: "tool_execution_start",
          toolName,
          ts: new Date().toISOString(),
        });

        // Enforce "read-before-write" policy
        if (toolName === "edit" || toolName === "write") {
          const params = ctx.toolCall.arguments as Record<string, unknown>;
          const filePath = typeof params.path === "string" ? normalizeToolPath(params.path) : "";
          const resolved = isAbsolute(filePath)
            ? normalize(filePath)
            : normalize(join(this.ctx?.workspaceRoot ?? process.cwd(), filePath));

          // Check if file exists and hasn't been read
          if (await pathExists(resolved)) {
            const alreadyRead = stats.readFiles.includes(resolved) || stats.readFiles.includes(filePath);
            if (!alreadyRead) {
              // Policy violation: reject the tool call
              onEvent?.(taskId, {
                type: "policy_violation",
                tool: toolName,
                path: params.path,
                reason: "must read file before modifying",
                ts: new Date().toISOString(),
              });
              return {
                block: true,
                reason: `Policy violation: you must call read_file on ${params.path} before ${toolName}. Reading a file establishes awareness of its current content.`,
              };
            }
          }

          // Enforce "search-before-write" policy (if webSearch is enabled)
          if (webSearchExists && toolName === "write") {
            const params = ctx.toolCall.arguments as Record<string, unknown>;
            const content = typeof params.content === "string" ? params.content : "";
            if (stats.searches === 0 && content.length > 50) {
              onEvent?.(taskId, {
                type: "policy_violation",
                tool: "write",
                path: params.path,
                reason: "must search before writing (at least one web_search call required)",
                ts: new Date().toISOString(),
              });
              return {
                block: true,
                reason: "Policy violation: at least one web_search call is required before writing files for coding tasks. This ensures knowledge of correct API usage and best practices.",
              };
            }
          }
        }

        return undefined;
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
