// Pi Worker（spec §16）— 第一個 CodingWorker 實作。
//
// 責任邊界（§16）：
//   Control Plane → PiWorker → Pi → Local LLM
//   Pi 不負責：Research decision / Policy decision / Artifact authorization / Escalation decision
//   Pi 只負責：「拿到已經準備好的 evidence/context 後，把 coding 做完。」
//
// 實作策略：
//   1. llama.cpp OpenAI-compatible endpoint（llama-server /v1/chat/completions）— 設定化 baseUrl + model
//   2. evidence 內容以 §16 contract JSON 雛形傳遞（不直接塞 raw search result）
//   3. stub 模式（llama.cpp 未安裝/未啟動時）：同 interface，回傳可測的最小 patch 路徑
//   4. interrupt() 中斷進行中的 execute（AbortController 貫穿）

import type {
  CodingWorker,
  WorkerContext,
  WorkerRequest,
  WorkerResult,
} from "./types.js";
import { LlamaClient, LlamaConnectionError } from "./llama-client.js";
import { minimatch } from "minimatch";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StyleCase } from "../rag/style-kb.js";
import { MemoryRetriever } from "../memory/retriever.js";
import type { MemoryRecord } from "../memory/types.js";

/** §16 contract JSON 雛形 — Control Plane ↔ Pi 之間的最小 contract。 */
export interface PiContract {
  task_id: string;
  objective: string;
  evidence: Array<{ source: string; fact: string }>;
  allowed_files: string[];
  readonly_files: string[];
  verification: string[];
  /** T021 §16：上一輪驗證失敗輸出（重試回饋）。 */
  previous_feedback?: string;
  /** T032：專案記憶片段（從 project_memory 檢索的相關修正模式）。 */
  project_memory?: MemoryRecord[];
}

export interface PiWorkerOptions {
  /** 未連到 llama.cpp 時用 stub 路徑（Q8 之後才需要真正 A/B）。 */
  allowStub?: boolean;
  /** llama.cpp endpoint 探測超時（ms），預設 3000。 */
  pingTimeoutMs?: number;
  /** llama 模式生成超時（ms），預設 300_000（5 分鐘；7B 在 CPU 上生成 patch 可達 60s+）。 */
  llamaTimeoutMs?: number;
  /** llama 模式生成 max_tokens，預設 500（patch 任務輸出有限；防 CPU 推理無限生成）。 */
  llamaMaxTokens?: number;
  /** T029：RAG 檢索器（輸入 contract → 歷史風格修正案例）。未設定 → 不注入 RAG 區塊。 */
  ragRetriever?: (contract: PiContract) => StyleCase[] | Promise<StyleCase[]>;
  /** T032：專案記憶檢索器（輸入 project name → 專案內成功修正模式）。未設定 → 不注入 Memory 區塊。 */
  memoryRetriever?: MemoryRetriever;
}

const DEFAULT_STUB_TIMEOUT_MS = 5_000;
const DEFAULT_LLAMA_TIMEOUT_MS = 300_000;
const DEFAULT_LLAMA_MAX_TOKENS = 500;

/**
 * 風格規範常數（T027）— 注入 system prompt，讓模型生成程式碼符合專案 lint 標準。
 * 對應 lint 規則：
 *   F401  import 位置（所有 import 集中於檔案頂端，勿在函式內）
 *   E302  空行（top-level 定義前需 2 空行；class 內 method 間 1 空行）
 *   E501  行長（≤ 88 字元，超過需換行或縮排續行）
 *   F403  星號匯入（禁止 `from x import *`）
 *   W291  行尾空白（行尾不得有空白字元）
 *   I001  import 順序（stdlib → third-party → local，每組內依字母序）
 * 以 Python 為基準；其他語言套用對應慣例（同為 lint=FAIL 主因）。
 */
export const STYLE_RULES = [
  "風格規範（所有語言通用，Python 為基準；違反任一項即 lint=FAIL）：",
  "1. import 位置：所有 import 必須集中在檔案最頂端（module docstring 之後）；嚴禁在函式/class 內部 import。",
  "2. 空行：top-level 的 function/class 定義前必須有 2 個空行；class 內 method 之間 1 個空行；檔案結尾必須有單一換行（不得多餘空行）。",
  "3. 行長：每行 ≤ 88 字元；超長時用括號換行、續行或拆成多行，不得超過。",
  "4. 星號匯入：禁止 `from x import *` 或 `import *`；只能顯式列出要匯入的名稱。",
  "5. 行尾空白：任何行尾不得有空白字元（trailing whitespace）；空行不得含空白。",
  "6. import 順序：stdlib → third-party → local 依序分組，組間空一行；每組內依字母序排列。",
  "7. 命名：snake_case（函式/變數）、PascalCase（class）、常數全大寫；與現有檔案風格一致。",
  "8. 未使用 import/變數：不要匯入或定義未使用的名稱；刪除舊的未使用 import。",
  "9. 生成 patch 時：只輸出實際修改的 hunk，不要重新輸出未修改的整段程式碼（避免無關 diff noise）。",
].join("\n");

/**
 * Few-shot 案例（T028）— 精選「錯誤 → 修正」對照，讓模型第一次就符合風格規範。
 * 案例均以 Python 為例（lint=FAIL 主因，對應 T027 規範項目）：
 *   1. F401：function 內 import → 移到檔案頂端
 *   2. E302：top-level 定義前缺 2 空行
 *   3. E501：行長超過 88 字元
 *   4. F403：星號匯入 `from x import *`
 * 每筆只展示「關鍵變更 diff」（不放完整檔案），總長度 < 800 tokens。
 */
export const FEW_SHOT_STYLE_FIXES = [
  "## Few-shot：錯誤 → 修正對照（案例均符合上方風格規範；只展示關鍵變更）",
  "案例 1 — F401 import 位置（嚴禁函式內 import）",
  "錯誤輸出：",
  "def fetch(url):",
  "    import requests    # 錯誤：函式內 import（F401）",
  "    return requests.get(url)",
  "修正後 code diff（保留既有 docstring 不動）：",
  " \"\"\"Module docstring（既有內容，保留）。\"\"\"",
  "+import requests",
  "+",
  " def fetch(url):",
  "-    import requests",
  "     return requests.get(url)",
  "案例 2 — E302 空行（top-level 定義前需 2 空行）",
  "錯誤輸出：",
  "import json",
  "",
  "def load_config(text):      # 錯誤：import 後只空 1 行（E302）",
  "    return json.loads(text)",
  "修正後 code diff：",
  " import json",
  "+",
  "+",
  " def load_config(text):",
  "案例 3 — E501 行長（≤ 88 字元）",
  "錯誤輸出：",
  "    return collect_metrics(process=process, labels=labels, cache=cache, retries=retries)   # 錯誤：超過 88 字元",
  "修正後 code diff：",
  "-    return collect_metrics(process=process, labels=labels, cache=cache, retries=retries)",
  "+    return collect_metrics(",
  "+        process=process,",
  "+        labels=labels,",
  "+        cache=cache,",
  "+        retries=retries,",
  "+    )",
  "案例 4 — F403 星號匯入（禁止 from x import *）",
  "錯誤輸出：",
  "from os import *     # 錯誤：星號匯入（F403）",
  "修正後 code diff：",
  "-from os import *",
  "+import os",
  "注意：修改現有檔案時保留既有 docstring 與未修改內容原樣；diff 用 ---/+++/@@ hunk 標頭，只含真正變更的行。",
].join("\n");

export class PiWorker implements CodingWorker {
  readonly id = "pi-local";
  private ctx: WorkerContext | null = null;
  private client: LlamaClient | null = null;
  private stubMode = false;
  private interruptedFlag = false;
  private readonly allowStub: boolean;
  private readonly pingTimeoutMs: number;
  private readonly llamaTimeoutMs: number;
  private readonly llamaMaxTokens: number;
  private readonly ragRetriever: ((contract: PiContract) => StyleCase[] | Promise<StyleCase[]>) | null;
  private readonly memoryRetriever: MemoryRetriever | null;

  constructor(opts: PiWorkerOptions = {}) {
    this.allowStub = opts.allowStub ?? true;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 3_000;
    this.llamaTimeoutMs = opts.llamaTimeoutMs ?? DEFAULT_LLAMA_TIMEOUT_MS;
    this.llamaMaxTokens = opts.llamaMaxTokens ?? DEFAULT_LLAMA_MAX_TOKENS;
    this.ragRetriever = opts.ragRetriever ?? null;
    this.memoryRetriever = opts.memoryRetriever ?? null;
  }

  get mode(): "llama" | "stub" {
    return this.stubMode ? "stub" : "llama";
  }

  async initialize(context: WorkerContext): Promise<void> {
    // 冪等：已初始化過（stub 或 llama 模式已定）就不重探測，避免 runner 用不同 baseUrl 覆蓋
    if (this.client && this.ctx) {
      return;
    }
    this.ctx = context;
    this.client = new LlamaClient({
      baseUrl: context.baseUrl,
      model: context.model,
      pingTimeoutMs: this.pingTimeoutMs,
    });
    // 探測 llama-server：可達 → llama 模式；不可達 → stub 模式（§16 備註：Pi 尚未安裝時先走 stub）
    const ping = await this.client.ping();
    if (ping.ok) {
      this.stubMode = false;
    } else {
      this.stubMode = true;
      if (!this.allowStub) {
        throw new LlamaConnectionError(
          `llama.cpp endpoint unreachable at ${context.baseUrl} and stub disabled`,
        );
      }
    }
    // T032：載入專案記憶（以 workspace 路徑最後一段作為 project 名稱）
    if (this.memoryRetriever && context.workspaceRoot) {
      const projectName = context.workspaceRoot.split("/").pop() ?? "default";
      const memories = this.memoryRetriever.listMemories(projectName);
      console.error(`[pi-worker] loaded ${memories.length} project memories for ${projectName}`);
    }
  }

  async interrupt(): Promise<void> {
    this.interruptedFlag = true;
    this.client?.interrupt();
  }

  async shutdown(): Promise<void> {
    this.interruptedFlag = true;
    this.client = null;
  }

  /** 建構 §16 contract JSON（evidence 以 evidence 欄位傳遞）。 */
  private buildContract(req: WorkerRequest): PiContract {
    const contract: PiContract = {
      task_id: req.task.id,
      objective: req.task.request ?? "",
      evidence: req.evidence.facts.map((f) => ({
        source: f.source,
        fact: f.claim,
      })),
      allowed_files: req.executionPolicy.allowedFiles,
      readonly_files: req.executionPolicy.readonlyFiles,
      verification: req.executionPolicy.verification,
      ...(req.previousFeedback ? { previous_feedback: req.previousFeedback } : {}),
    };

    // T032：注入專案記憶片段（依語言、錯誤類型檢索）
    if (this.memoryRetriever && this.ctx?.workspaceRoot) {
      const projectName = this.ctx.workspaceRoot.split("/").pop() ?? "default";
      const language = req.workspace?.languages?.[0] ?? "python";
      // 從 previous_feedback 推斷錯誤類型
      const errorTypes = this.extractErrorTypes(req.previousFeedback ?? "");
      const query = `${language} ${errorTypes.join(" ")} ${req.task.request?.slice(0, 100) ?? ""}`;
      const memories = this.memoryRetriever.retrieveMemory({
        project: projectName,
        query,
        topK: 3,
        threshold: 0.7,
      });
      if (memories.length > 0) {
        contract.project_memory = memories.map((m) => m.record);
        console.error(`[pi-worker] injected ${memories.length} project memories into contract`);
      }
    }

    return contract;
  }

  /** 從驗證失敗輸出抽取 lint 錯誤代碼。 */
  private extractErrorTypes(feedback: string): string[] {
    const found = new Set<string>();
    feedback.replace(/([A-Z]\d{3})/g, (m) => {
      if (!/^(E9|F|W|I|E1|E2|E3|E4|E7|E8)/.test(m)) return m;
      found.add(m);
      return m;
    });
    return [...found];
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    this.interruptedFlag = false;
    const started = Date.now();
    const contract = this.buildContract(request);
    console.error(`[pi-worker] execute mode=${this.stubMode ? "stub" : "llama"} task=${request.task.id}`);

    if (this.interruptedFlag) {
      return this.fail("interrupted before execution", started, "tool_error", "interrupted before execution");
    }

    if (this.stubMode) {
      return this.runStub(request, contract, started);
    }
    return this.runLlama(request, contract, started);
  }

  // ── llama 模式：真正呼叫 llama.cpp OpenAI-compatible endpoint ──────────

  private async runLlama(
    request: WorkerRequest,
    contract: PiContract,
    started: number,
  ): Promise<WorkerResult> {
    if (!this.ctx || !this.client) {
      return this.fail("worker not initialized", started, "environment_error", "PiWorker.initialize() not called");
    }
    const systemPrompt = [
      "你是 Control Plane 的 coding worker。",
      "你只負責根據 evidence 與 plan 完成 coding 任務。",
      "你沒有 web search 能力——所有 research 已由 Control Plane 完成並放在 evidence 中。",
      "輸出格式：先輸出簡短計畫（≤5 行），然後輸出 unified diff patch（---/+++ 格式），最後一行輸出 DONE 或 FAILED: <原因>。",
"重要：驗證在無網路的 sandbox 中執行——測試程式不得呼叫真實網路（外部 API/URL）；若要模擬外部服務請用 monkeypatch / stub。",
      STYLE_RULES,
      FEW_SHOT_STYLE_FIXES,
      ...(await this.buildRagBlock(contract)),
    ].join("\n");
    const userPrompt = [
      `## Task`,
      contract.objective,
      `## Evidence（Control Plane 已 research，勿自行查詢）`,
      contract.evidence.map((e) => `- [${e.source}] ${e.fact}`).join("\n"),
      `## Allowed files（只能改這些）`,
      contract.allowed_files.join(", "),
      `## Readonly files（不可改）`,
      contract.readonly_files.join(", "),
      `## Verification`,
      contract.verification.join("; "),
      ...(contract.previous_feedback
        ? [
            `## 上一輪驗證失敗（必須修正這些問題後再出 patch）`,
            contract.previous_feedback.slice(0, 4000),
          ]
        : []),
      `## Workspace files（請以此為準修改/延伸現有程式碼；tests/test_api_client.py 是驗收基準，絕對不可修改，新增測試請開新檔）`,
      this.readWorkspaceContext(contract),
      `## 輸出格式`,
      `1. 計畫（≤5 行）`,
      `2. 完整 unified diff（--- a/ +++ b/），必須是 git apply 可套用的格式（hunk 行數要正確）`,
      `3. 最後一行：DONE`,
    ].join("\n\n");

    try {
      const res = await this.client.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        {
          timeoutMs: this.llamaTimeoutMs,
          // patch 任務輸出有限（計畫 + diff + DONE），500 tokens 足够；
          // 避免 CPU 推理下 4096 預設導致幾分鐘的無意義生成（T023 實測）
          maxTokens: this.llamaMaxTokens,
        },
      );
      const output = res.text;
      if (this.interruptedFlag) {
        return this.fail("interrupted during generation", started, "tool_error", "interrupted during generation");
      }
      const done = /DONE/.test(output);
      const failedMatch = /FAILED:\s*(.+)/.exec(output);
      if (!done && failedMatch) {
        const reason = failedMatch[1] ?? "unknown failure";
        return this.fail(
          reason.trim(),
          started,
          this.classifyFailure(reason),
          output,
        );
      }

      // T032：成功完成且有 patch 時，提取關鍵修正模式存入專案記憶
      if (done && this.memoryRetriever && this.ctx?.workspaceRoot) {
        const projectName = this.ctx.workspaceRoot.split("/").pop() ?? "default";
        const language = request.workspace?.languages?.[0] ?? "python";
        const patch = this.extractPatch(output) ?? "";
        if (patch) {
          // 從 patch 推斷錯誤類型（簡單啟發式：檢查 diff 中的錯誤模式）
          const errorTypes = this.extractErrorTypesFromPatch(patch);
          const tags = [language, ...errorTypes, "style_fix"];
          this.memoryRetriever.storeMemory({
            taskId: request.task.id,
            project: projectName,
            language,
            errorType: errorTypes[0] ?? "STYLE_FIX",
            fixedDiff: patch.slice(0, 1000), // 只存關鍵 diff 片段
            tags,
          });
          console.error(`[pi-worker] stored project memory for ${projectName}: ${errorTypes.join(",") || "STYLE_FIX"}`);
        }
      }

      return {
        ok: done,
        patch: this.extractPatch(output),
        changedFiles: this.extractChangedFiles(output),
        summary: output.slice(0, 300),
        output,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const e = err as Error;
      if (e.name === "LlamaConnectionError" && this.interruptedFlag) {
        return this.fail("interrupted", started, "tool_error", e.message);
      }
      return this.fail(e.message, started, "tool_error", e.message);
    }
  }

  /** T029：依 contract 檢索 RAG 案例並格式化為最低優先序區塊（≤500 tokens；無結果 → 略過）。 */
  private async buildRagBlock(contract: PiContract): Promise<string[]> {
    if (!this.ragRetriever) return [];
    let cases: StyleCase[];
    try {
      cases = await this.ragRetriever(contract);
    } catch {
      return [];
    }
    if (cases.length === 0) return [];
    const SNIPPET_MAX = 200;
    const DIFF_MAX = 380;
    const lines: string[] = ["## RAG 歷史修正案例（同語言/同錯誤類型；最低優先，僅供參考）"];
    for (const c of cases) {
      const date = c.createdAt.slice(0, 10);
      const snippet = c.errorSnippet.length > SNIPPET_MAX
        ? c.errorSnippet.slice(0, SNIPPET_MAX) + "…"
        : c.errorSnippet;
      const diff = c.fixedDiff.length > DIFF_MAX
        ? c.fixedDiff.slice(0, DIFF_MAX) + "…"
        : c.fixedDiff;
      lines.push(
        `### ${c.errorType} / ${c.language} / ${date}`,
        "❌ 錯誤輸出：",
        snippet || "(空)",
        "✅ 修正後 code diff：",
        diff || "(空)",
      );
    }
    return [lines.join("\n")];
  }

  /** 從 patch 推斷錯誤類型（簡單啟發式：檢查 diff 中常見錯誤模式）。 */
  private extractErrorTypesFromPatch(patch: string): string[] {
    const found = new Set<string>();
    const lower = patch.toLowerCase();
    // 常見 Python lint 錯誤模式
    if (/(^|\s)import\s+\w+\s+inside\s+function/.test(patch) || /def\s+\w+\([^)]*\):\s*\n\s+import\s/.test(patch)) {
      found.add("F401");
    }
    if (/^\s*def\s+\w+\(/m.test(patch) && !/^\n{2}def\s/m.test(patch)) {
      found.add("E302");
    }
    if (/.{89,}/.test(patch)) {
      found.add("E501");
    }
    if (/from\s+\w+\s+import\s+\*/.test(patch)) {
      found.add("F403");
    }
    if (/trailing\s+whitespace/.test(patch)) {
      found.add("W291");
    }
    if (/import\s+order/.test(patch)) {
      found.add("I001");
    }
    return [...found];
  }

  // ── stub 模式：無 llama.cpp 時的最小可測路徑（§16 備註）───────────────

  private async runStub(
    request: WorkerRequest,
    contract: PiContract,
    started: number,
  ): Promise<WorkerResult> {
    // 模擬一小段「思考」延遲，讓 interrupt 有機會介入
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.interruptedFlag) {
      return this.fail("interrupted", started, "tool_error", "interrupted");
    }
    const patch = this.buildStubPatch(request);
    return {
      ok: true,
      patch,
      changedFiles: this.stubChangedFiles(request),
      summary: `[stub] ${request.task.id}: 收到 ${contract.evidence.length} 筆 evidence、plan ${request.plan.steps.length} 步。`,
      output: `[stub pi-worker] evidence=${contract.evidence.length} allowed=${contract.allowed_files.length}`,
      durationMs: Date.now() - started,
    };
  }

  /** stub patch：以 allowed_files 內第一個實際存在的檔案為目標（git-style header）。 */
  private buildStubPatch(req: WorkerRequest): string {
    const target = this.stubTargetFile(req.executionPolicy.allowedFiles) ?? "CHANGES.md";
    const lines = [
      `diff --git a/${target} b/${target}`,
      `--- a/${target}`,
      `+++ b/${target}`,
      `@@ -0,0 +1,4 @@`,
      `+# ${req.task.id} — ${req.task.request.slice(0, 80)}`,
      `+# stub worker patch（llama.cpp 未啟動）`,
      `+#`,
      `+# placeholder change`,
    ];
    return lines.join("\n") + "\n";
  }

  /** 在 workspaceRoot 下遞迴找第一個符合 allowed glob 的檔案（排除 node_modules/.git）。 */
  private stubTargetFile(globs: string[]): string | null {
    const root = this.ctx?.workspaceRoot;
    if (!root) return null;
    const walk = (dir: string): string | null => {
      let entries: import("node:fs").Dirent<string>[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent<string>[];
      } catch {
        return null;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const abs = join(dir, e.name);
        const rel = abs.slice(root.length + 1);
        if (e.isDirectory()) {
          const found = walk(abs);
          if (found) return found;
        } else if (globs.some((g) => minimatch(rel, g))) {
          return rel;
        }
      }
      return null;
    };
    return walk(root);
  }

  private stubChangedFiles(req: WorkerRequest): string[] {
    const target = req.executionPolicy.allowedFiles[0];
    return target ? [target] : [];
  }

  // ── 工具 ──────────────────────────────────────────────────────────────

  private fail(
    message: string,
    started: number,
    classification: string,
    output?: string,
  ): WorkerResult {
    return {
      ok: false,
      changedFiles: [],
      summary: message.slice(0, 300),
      errorClassification: classification,
      output,
      durationMs: Date.now() - started,
    };
  }

  /** 從模型輸出抽取 unified diff 區塊，僅保留 diff 行（截掉 fence/散文/Verification 摘要）。 */
  private extractPatch(output: string): string | undefined {
    const start = output.indexOf("--- ");
    if (start === -1) return undefined;
    const lines = output.slice(start).split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      // 遇到「看起來合理解釋文本」fence / 摘要行 → 終止收集（T023 實測：模型補 ``` 與 Verification）
      if (
        /^```/.test(line) ||
        /^###?\s/.test(line) ||
        /^(DONE|FAILED|Verification|verification):?/i.test(line)
      ) {
        break;
      }
      if (
        /^[+-]/.test(line) ||
        /^@@/.test(line) ||
        /^--- /.test(line) ||
        /^\+\+\+ /.test(line) ||
        /^diff --git /.test(line) ||
        /^index /.test(line) ||
        /^new file mode/.test(line) ||
        /^\\ No newline/.test(line) ||
        /^ /.test(line) ||
        line === ""
      ) {
        kept.push(line);
      } else {
        break;
      }
    }
    // 移除前導/尾部 ``` fence 行（防模型在 diff 開頭或尾部補碼）
    while (kept.length > 0 && /^```/.test(kept[0]!)) kept.shift();
    while (kept.length > 0 && /^```/.test(kept[kept.length - 1]!)) kept.pop();
    const cleaned = kept.join("\n").trim();
    return cleaned ? cleaned + "\n" : undefined;
  }

  private extractChangedFiles(output: string): string[] {
    const files: string[] = [];
    for (const m of output.matchAll(/^\+\+\+\s+(?:\S+\/)?(\S+)$/gm)) {
      files.push(m[1]!);
    }
    return files;
  }

  /** 讀取 workspace 現有檔案內容（限制大小）作為 model context（worker 真實行為：先看 repo）。 */
  private readWorkspaceContext(contract: PiContract): string {
    const root = this.ctx?.workspaceRoot;
    if (!root) return "(workspace 不可用)";
    const cap = 6000;
    const parts: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (parts.length >= 1 && parts.join("\n").length > cap) return;
        if (
          e.name === "node_modules" ||
          e.name === ".git" ||
          e.name === ".pytest_cache" ||
          e.name === "__pycache__"
        ) {
          continue;
        }
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
          continue;
        }
        const rel = abs.slice(root.length + 1);
        // 只送會影響 coding 決策的檔案（原始碼 / 設定 / 測試）
        if (!/\.(py|ts|tsx|js|json|toml|yaml|yml|go|tf|rb|sh)$/.test(rel)) continue;
        if (rel.startsWith(".acp")) continue;
        let content: string;
        try {
          content = readFileSync(abs, "utf8").slice(0, 4000);
        } catch {
          continue;
        }
        parts.push(`### ${rel}\n${content}`);
      }
    };
    walk(root);
    let text = parts.join("\n\n");
    if (text.length > cap) text = text.slice(0, cap) + "\n…(truncated)";
    return text || "(無原始檔)";
  }

  /** 簡易失敗分類（配合 T020 Reflection error-signature）。 */
  private classifyFailure(text: string): string {
    const t = text.toLowerCase();
    if (/not found|no such file|unknown/.test(t)) return "coding_error";
    if (/permission|eacces|denied/.test(t)) return "environment_error";
    if (/timeout|unreachable|connection/.test(t)) return "tool_error";
    return "coding_error";
  }
}
