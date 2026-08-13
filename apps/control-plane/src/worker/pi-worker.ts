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

/** §16 contract JSON 雛形 — Control Plane ↔ Pi 之間的最小 contract。 */
export interface PiContract {
  task_id: string;
  objective: string;
  evidence: Array<{ source: string; fact: string }>;
  allowed_files: string[];
  readonly_files: string[];
  verification: string[];
}

export interface PiWorkerOptions {
  /** 未連到 llama.cpp 時用 stub 路徑（Q8 之後才需要真正 A/B）。 */
  allowStub?: boolean;
  /** llama.cpp endpoint 探測超時（ms），預設 3000。 */
  pingTimeoutMs?: number;
}

const DEFAULT_STUB_TIMEOUT_MS = 5_000;

export class PiWorker implements CodingWorker {
  readonly id = "pi-local";
  private ctx: WorkerContext | null = null;
  private client: LlamaClient | null = null;
  private stubMode = false;
  private interruptedFlag = false;
  private readonly allowStub: boolean;
  private readonly pingTimeoutMs: number;

  constructor(opts: PiWorkerOptions = {}) {
    this.allowStub = opts.allowStub ?? true;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? 3_000;
  }

  get mode(): "llama" | "stub" {
    return this.stubMode ? "stub" : "llama";
  }

  async initialize(context: WorkerContext): Promise<void> {
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
    return {
      task_id: req.task.id,
      objective: req.task.request ?? "",
      evidence: req.evidence.facts.map((f) => ({
        source: f.source,
        fact: f.claim,
      })),
      allowed_files: req.executionPolicy.allowedFiles,
      readonly_files: req.executionPolicy.readonlyFiles,
      verification: req.executionPolicy.verification,
    };
  }

  async execute(request: WorkerRequest): Promise<WorkerResult> {
    this.interruptedFlag = false;
    const started = Date.now();
    const contract = this.buildContract(request);

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
    ].join("\n\n");

    try {
      const res = await this.client.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { timeoutMs: DEFAULT_STUB_TIMEOUT_MS * 4 },
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

  /** stub patch：以 allowed_files 第一檔為目標的佔位 diff。 */
  private buildStubPatch(req: WorkerRequest): string {
    const target = req.executionPolicy.allowedFiles[0] ?? "CHANGES.md";
    const lines = [
      `--- a/${target}`,
      `+++ b/${target}`,
      `@@ -0,0 +1,2 @@`,
      `+# ${req.task.id} — ${req.task.request.slice(0, 80)}`,
      `+# stub worker patch（llama.cpp 未啟動）`,
    ];
    return lines.join("\n");
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

  /** 從模型輸出抽取 unified diff 區塊。 */
  private extractPatch(output: string): string | undefined {
    const start = output.indexOf("--- ");
    if (start === -1) return undefined;
    // 取到 DONE / FAILED 前
    const endMarkers = ["\nDONE", "\nFAILED"];
    let end = output.length;
    for (const m of endMarkers) {
      const idx = output.indexOf(m, start);
      if (idx !== -1 && idx < end) end = idx;
    }
    return output.slice(start, end).trim();
  }

  private extractChangedFiles(output: string): string[] {
    const files: string[] = [];
    for (const m of output.matchAll(/^\+\+\+\s+(?:\S+\/)?(\S+)$/gm)) {
      files.push(m[1]!);
    }
    return files;
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
