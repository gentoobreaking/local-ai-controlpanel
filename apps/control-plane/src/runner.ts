// Task Runner（T008 stub → T010 Policy → T017/T018/T019/T020 接入 → T021 Worker）。
// 以 state machine 驅動 task：POLICY_CHECK 以 §10 Knowledge Policy 決定
// 是否需要研究；RESEARCH_REQUIRED 等待 Research Engine（HTTP，T017）；
// EVIDENCE_VALIDATION 由 Evidence Gate（T019）四分支決策；
// REFLECTION（T020）分類失敗 → retry/research/ask_user/stop；
// IMPLEMENTING（T021）經 Worker Interface 選派 Pi Worker 產出 patch。
// emit SSE stage 事件、支援 cancel / approve。

import { createStateMachine } from "./state/state-machine.js";
import { classify, canRetry } from "./reflection/engine.js";
import type { PolicyEngine } from "./policy/engine.js";
import type { StageEvent, TaskBus } from "./events/bus.js";
import type { TaskManager } from "./task/task-manager.js";
import type { TaskRow, TaskStatus } from "./task/types.js";
import type { CodingWorker } from "./worker/types.js";
import type { EvidenceDecision } from "./evidence/gate.js";
import { validateEvidenceGate } from "./evidence/gate.js";
import type { ResearchSummary, TaskAnalysis } from "./policy/types.js";
import type { WorkerRegistry } from "./worker/registry.js";
import { WorkerRouter } from "./worker/registry.js";
import type { WorkerRequest, WorkerResult } from "./worker/types.js";
import { PiWorker } from "./worker/pi-worker.js";

export interface TaskRunner {
  start(taskId: string): void;
  cancel(taskId: string): void;
  approve(taskId: string): void;
  /** 回報 research 完成結果（由 research 整合層呼叫，T017/T019 接入）。 */
  reportResearch(taskId: string, summary: ResearchSummary, stage1: "COMPLETE" | "PARTIAL" | "FAILED"): void;
  /** 回報 verification 失敗（T020 接入 reflection）。 */
  reportVerificationFailure(taskId: string, output: string): void;
  /** T040 整合層回報：artifact 驗證（policy + git dry-run）結果。 */
  reportArtifactValidation(taskId: string, ok: boolean, reason?: string): void;
  reportVerificationResult(taskId: string, ok: boolean, output: string): void;
  /** T021：回報 worker 執行結果（產出 patch）。 */
  reportWorkerResult(taskId: string, result: WorkerResult): void;
  /** 目前進行的階段（供 SSE 重連 replay 快照）。 */
  getStage(taskId: string): { stage: TaskStatus; attempt: number } | undefined;
}

export function createRunner(
  taskManager: TaskManager,
  bus: TaskBus,
  policyEngine: PolicyEngine,
  deps: {
    workerRegistry?: WorkerRegistry;
    /** T017 整合層：task 進入 RESEARCHING 時觸發研究，完成後呼叫 reportResearch()。 */
    onResearchRequired?: (taskId: string, query: string, workspace?: string) => void;
    /** T011/T040 整合層：task 進入 ARTIFACT_VALIDATION 時觸發 patch 驗證+套用。 */
    onArtifactValidation?: (taskId: string, workspace?: string) => void;
    /** T012 整合層：task 進入 VERIFYING 時觸發沙箱驗證。 */
    onVerificationRequired?: (taskId: string, workspace?: string) => void;
    /** Agentic 搜尋迴圈：網路檢索執行器（GitHub MCP / PyPI / Scrapling）。 */
    webSearch?: (query: string, language?: string) => Promise<
      Array<{ title: string; snippet: string; confidence: number; metadata?: Record<string, unknown> }>
    >;
    /** Agentic 搜尋迴圈設定 */
    agenticSearch?: { maxRounds: number };
  } = {},
): TaskRunner {
  const notifyVerificationRequired = deps.onVerificationRequired;
  const webSearchFn = deps.webSearch;
  const agenticMaxRounds = deps.agenticSearch?.maxRounds ?? 10;
  const runningStages = new Map<string, { stage: TaskStatus; attempt: number }>();
  const researchState = new Map<string, { retries: number; task: TaskRow }>();
  const workerState = new Map<string, { request: WorkerRequest; attempt: number }>();
  const notifyArtifactValidation = deps.onArtifactValidation;
  /** T021 §16：task → 上一輪驗證失敗輸出（重試時注入 worker request 回饋給模型）。 */
  const verificationFeedback = new Map<string, string>();
  const workerRegistry = deps.workerRegistry;
  const notifyResearchRequired = deps.onResearchRequired;
  const router = workerRegistry ? new WorkerRouter(workerRegistry) : null;
  // Worker 初始化 context：llama.cpp baseUrl 由環境變數設定（§16 設定化）
  const llmBaseUrl = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";
  const llmModel = process.env.LLAMA_MODEL ?? "qwen2.5-coder:7b";
  const initializedWorkers = new Set<string>();
  const emit = (taskId: string, e: StageEvent) => bus.emit(taskId, e);

  const emitStage = (taskId: string, task: TaskRow) => {
    runningStages.set(taskId, { stage: task.status, attempt: task.attempt });
    emit(taskId, {
      type: "stage",
      stage: task.status,
      attempt: task.attempt,
      ts: new Date().toISOString(),
    });
  };

  const toResearchSummary = (): ResearchSummary => ({
    facts: 2,
    sourcesCount: 1,
    officialSources: 0,
  });

  /** EVIDENCE_VALIDATION：以 gate 決策驅動狀態轉移（T019）。 */
  function runEvidenceValidation(task: TaskRow, summary: ResearchSummary, stage1: "COMPLETE" | "PARTIAL" | "FAILED"): void {
    // 先進入 EVIDENCE_VALIDATION（RESEARCHING → EVIDENCE_VALIDATION），再依決策轉出
    step(task, "EVIDENCE_VALIDATION");
    const retries = researchState.get(task.id)?.retries ?? 0;
    const decision: EvidenceDecision = validateEvidenceGate(
      { stage1, summary, risk: task.risk ?? "medium", researchRetries: retries },
      policyEngine,
    );

    // 記錄 gate 決策（§36.2 Prevention Rate）
    if (decision.status === "BLOCK" || decision.status === "DEGRADED") {
      taskManager.recordGateBlock(
        task.id,
        decision.status,
        decision.stage1,
        decision.stage2,
        decision.reason,
        decision.retriesUsed,
      );
    }
    emit(task.id, {
      type: "evidence",
      evidenceCount: summary.facts,
      confidence: summary.facts > 0 ? 0.7 : undefined,
      ts: new Date().toISOString(),
    });

    switch (decision.status) {
      case "PASS":
        step(task, "PLANNING");
        step(task, "WORKER_SELECTION");
        step(task, "IMPLEMENTING");
        void runWorker(taskManager.getRow(task.id)!);
        break;
      case "RESEARCH_AGAIN": {
        const nextRetries = retries + 1;
        notifyResearchRequired?.(task.id, task.request, task.workspace ?? undefined);
        researchState.set(task.id, { retries: nextRetries, task });
        step(task, "RESEARCHING");
        emit(task.id, {
          type: "reflection",
          classification: "knowledge_error",
          action: "research",
          ts: new Date().toISOString(),
        });
        break;
      }
      case "DEGRADED": {
        // 帶旗標降級：進入 PLANNING（記錄 flags）
        taskManager.addFlag(task.id, "degraded:" + decision.reason);
        step(task, "PLANNING");
        step(task, "WORKER_SELECTION");
        step(task, "IMPLEMENTING");
        void runWorker(taskManager.getRow(task.id)!);
        break;
      }
      case "BLOCK":
        // 知識缺口（硬性）→ ASK_USER；policy 無解 → STOP
        step(task, "ASK_USER");
        break;
    }
  }

  /** REFLECTION：分類失敗 → 對應動作（T020，§23 retry.on 表驅動）。 */
  function runReflection(task: TaskRow, output: string): void {
    const result = classify({ output });
    const policyAction = policyEngine.retryActionFor(result.classification);
    const action = policyAction ?? result.recommendedAction;
    taskManager.recordReflection(
      task.id,
      task.attempt,
      result.classification,
      result.confidence,
      action,
    );
    emit(task.id, {
      type: "reflection",
      classification: result.classification,
      action,
      ts: new Date().toISOString(),
    });
    switch (action) {
      case "retry":
        if (canRetry(task.attempt - 1, policyEngine.retryMaxAttempts())) {
          taskManager.setAttempt(task.id, task.attempt + 1);
          step(task, "IMPLEMENTING");
          void runWorker(taskManager.getRow(task.id)!);
        } else {
          step(task, "STOP");
        }
        break;
      case "research":
        step(task, "RESEARCH_REQUIRED");
        notifyResearchRequired?.(task.id, task.request, task.workspace ?? undefined);
        step(task, "RESEARCHING");
        break;
      case "ask_user":
        step(task, "ASK_USER");
        break;
      case "repair_environment":
        step(task, "ARTIFACT_VALIDATION");
        break;
      case "stop":
      case "stronger_model":
        // Phase 1–5：stronger_model 不實作（§25），一律 STOP
        step(task, "STOP");
        break;
    }
  }

  function step(task: TaskRow, next: TaskStatus): void {
    // 每次從 DB 讀最新狀態（連續轉移時 task 快照已過期）
    const current = taskManager.getRow(task.id);
    if (!current) return;
    const sm = createStateMachine(current.status);
    try {
      sm.transition(next);
    } catch (err) {
      console.warn(
        `[runner] ${task.id} invalid transition ${sm.state} → ${next}: ${(err as Error).message}`,
      );
      return;
    }
    const updated = taskManager.updateStatus(task.id, sm.state);
    emitStage(task.id, updated);
  }

  function run(task: TaskRow): void {
    if (taskManager.isTerminal(task.status)) return;
    const sm = createStateMachine(task.status);

    // 最小 pipeline（§38 Phase 1 驗證：Task → Policy → Research 邊界）。
    switch (sm.state) {
      case "CREATED":
        step(task, "ANALYZING");
        step(task, "POLICY_CHECK");
        {
          const analysis = {
            languages: [],
            frameworks: [],
            dependencies: [],
            complexity: "medium" as const,
            risk: "medium" as const,
            researchRequired: true,
            researchReasons: ["unknown_dependency"],
          };
          const decision = policyEngine.evaluateTask(analysis);
          if (decision.action === "ALLOW_PLANNING") {
            step(task, "PLANNING");
            step(task, "WORKER_SELECTION");
            step(task, "IMPLEMENTING");
            runWorker(taskManager.getRow(task.id)!);
          } else {
            // 研究需求確定 → 立即啟動 research（進入 RESEARCHING 等待 reportResearch）
            researchState.set(task.id, { retries: 0, task });
            notifyResearchRequired?.(task.id, task.request, task.workspace ?? undefined);
            step(task, "RESEARCH_REQUIRED");
            step(task, "RESEARCHING");
          }
        }
        break;
      default:
        // 已停在中途狀態（重啟/重連）或終態：不做任何事。
        break;
    }
  }

  /** 簡單的 task 分析建構器（供 Phase 9+ evaluateExecution 使用）。 */
  function buildTaskAnalysis(task: TaskRow): TaskAnalysis {
    // 這裡簡化：實際應由 analyzer 產生
    return {
      languages: ["typescript", "python", "go"].filter((l) =>
        task.request.toLowerCase().includes(l),
      ),
      frameworks: [],
      dependencies: [],
      complexity: task.risk === "high" ? "high" : task.risk === "low" ? "low" : "medium",
      risk: task.risk ?? "medium",
      researchRequired: true,
      researchReasons: ["unknown_dependency"],
    };
  }

  /**
   * Agentic 搜尋迴圈（§16 延伸）：模型自評證據缺口 → 迭代查詢 → 落庫供 coding 使用。
   * 結構性保證：SEARCHING 狀態內每輪必查（退化偵測 + 硬上限防打轉）。
   */
  async function runAgenticSearch(task: TaskRow, worker: CodingWorker): Promise<void> {
    const language = task.workspace?.split(".").pop() === "py" ? "python" : undefined;
    const seenQueries = new Set<string>();
    const missingHistory: string[] = [];
    let barrenRounds = 0;

    for (let round = 1; round <= agenticMaxRounds; round++) {
      const digest = taskManager
        .getEvidence(task.id)
        .map((e) => `- [${e.sourceType}] ${e.claim.slice(0, 150)}`)
        .join("\n");

      let verdict: Awaited<ReturnType<NonNullable<CodingWorker["evaluateSufficiency"]>>>;
      try {
        verdict = await worker.evaluateSufficiency!({
          objective: task.request ?? "",
          evidenceDigest: digest,
          missingHistory,
        });
      } catch {
        break; // 模型評估失敗 → 帶現有證據繼續
      }

      if (verdict.missing.length) missingHistory.push(...verdict.missing);

      // 退化偵測：新查詢全部重複 → 強制收斂
      const fresh = verdict.queries.filter((q) => {
        const norm = q.query.trim().toLowerCase();
        if (seenQueries.has(norm)) return false;
        seenQueries.add(norm);
        return true;
      });

      emit(task.id, {
        type: "search",
        round,
        maxRounds: agenticMaxRounds,
        sufficient: verdict.sufficient || fresh.length === 0 && verdict.missing.length === 0,
        missing: verdict.missing,
        queries: fresh,
        ts: new Date().toISOString(),
      });

      if (verdict.sufficient || fresh.length === 0) {
        console.error(`[runner] ${task.id} agentic search 收斂於 round ${round}`);
        return;
      }

      // 執行檢索（CP 側有網路；沙箱外）→ 證據落庫 → 自動流入 worker contract
      const facts: Array<{ claim: string; sourceUri: string; sourceType: string; confidence: number }> = [];
      const sources: string[] = [];
      for (const q of fresh.slice(0, 3)) {
        try {
          const results = webSearchFn
            ? await webSearchFn(q.query, language)
            : [];
          for (const r of results) {
            facts.push({
              claim: `${r.title}\n${r.snippet}`,
              sourceUri: String(r.metadata?.url ?? `search:${q.query}`),
              sourceType: "documentation",
              confidence: r.confidence ?? 0.65,
            });
            sources.push(String(r.metadata?.origin ?? "web"));
          }
        } catch {
          // 單一查詢失敗 → 忽略
        }
      }

      emit(task.id, {
        type: "search",
        round,
        maxRounds: agenticMaxRounds,
        sufficient: false,
        foundCount: facts.length,
        sources: [...new Set(sources)],
        evidence: facts.map((f) => ({
          title: f.claim.split("\n")[0] ?? "",
          url: f.sourceUri,
          snippet: f.claim.slice(0, 400),
        })),
        ts: new Date().toISOString(),
      });

      if (facts.length === 0) {
        barrenRounds += 1;
        if (barrenRounds >= 2) {
          console.error(`[runner] ${task.id} 連續 ${barrenRounds} 輪無新資訊 → 收斂`);
          return;
        }
      } else {
        barrenRounds = 0;
        taskManager.recordEvidence(task.id, facts);
      }
    }
    console.error(`[runner] ${task.id} agentic search 達上限 ${agenticMaxRounds} 輪 → 帶現有證據實作`);
  }

  /**
   * T021：IMPLEMENTING → Worker Interface 選派 Pi Worker → execute → patch。
   * llama.cpp 未啟動時 PiWorker 自動走 stub 快速路徑（§16 備註），
   * 讓 `Task → Worker → Patch` 最小 pipeline 可測。
   */
  async function runWorker(task: TaskRow): Promise<void> {
    if (!router || !workerRegistry) return;
    try {
      // 建立簡單的 task 分析（Phase 9+ 使用）
      const analysis = buildTaskAnalysis(task);
      const strategy = policyEngine.evaluateExecution(analysis);
      const { worker, descriptor } = router.select(task, strategy);
      // lazy initialize（PiWorker 探測 llama.cpp；同一 worker 只 init 一次）
      if (!initializedWorkers.has(descriptor.id)) {
        await worker.initialize({
          baseUrl: llmBaseUrl,
          model: strategy.model ?? llmModel,
          workspaceRoot: task.workspace ?? process.cwd(),
        });
        initializedWorkers.add(descriptor.id);
      }

      const request: WorkerRequest = {
        task,
        previousFeedback: verificationFeedback.get(task.id),
        evidence: {
          taskId: task.id,
          // Rule 3：research 落庫的 evidence 才可進入 coding（非 summary 計數）
          facts: taskManager.getEvidence(task.id).map((e) => ({
            id: `ev-${task.id}-${e.source}`,
            claim: e.claim,
            source: e.source,
            sourceType: e.sourceType,
            confidence: e.confidence,
            relevance: 1,
          })),
          constraints: [],
          versions: [],
          unresolvedQuestions: [],
          truncated: false,
          droppedFactIds: [],
          estimatedTokens: 0,
        },
        plan: { id: `plan-${task.id}`, steps: [{ id: "s1", description: task.request.slice(0, 120) }] },
        executionPolicy: {
          strategy: strategy.strategy,
          tier: strategy.tier,
          worker: descriptor.id,
          model: strategy.model,
          allowCloud: strategy.allowCloud,
          maxAttempts: strategy.maxAttempts,
          allowedFiles: policyEngine.allowedFiles(),
          readonlyFiles: policyEngine.readonlyFiles(),
          verification: policyEngine.verificationCommands(),
        },
        workspace: {
          path: task.workspace ?? process.cwd(),
          languages: [],
          frameworks: [],
        },
      };
      workerState.set(task.id, { request, attempt: task.attempt });
      const result = await worker.execute(request);
      reportWorkerResult(task.id, result);
    } catch (err) {
      const e = err as Error;
      reportWorkerResult(task.id, {
        ok: false,
        changedFiles: [],
        summary: `worker error: ${e.message}`,
        errorClassification: "tool_error",
        output: e.message,
        durationMs: 0,
      });
    }
  }

  /** T021：worker 執行完成 → patch 記錄 → ARTIFACT_VALIDATION / REFLECTION。 */
  function reportWorkerResult(taskId: string, result: WorkerResult): void {
    const task = taskManager.getRow(taskId);
    if (!task || task.status !== "IMPLEMENTING") return;
    const ws = workerState.get(taskId);
    if (result.ok) {
      // patch 記錄到 attempts（供 artifact 層套用）
      taskManager.recordAttempt(
        taskId,
        task.attempt,
        ws?.request.executionPolicy.worker ?? "pi-local",
        ws?.request.executionPolicy.model ?? "qwen2.5-coder:7b",
      );
      // patch 落庫（§20 patches 表；Artifact Controller 從 DB 讀取套用）
      if (result.patch) {
        taskManager.recordPatch?.(
          taskId,
          task.attempt,
          result.patch,
          result.changedFiles?.join(", ") ?? "",
        );
      }
      step(task, "ARTIFACT_VALIDATION");
      notifyArtifactValidation?.(taskId, task.workspace ?? undefined);
    } else {
      // 失敗 → REFLECTION（T020 分類 → retry / research / ask_user / stop）
      taskManager.recordAttempt(
        taskId,
        task.attempt,
        ws?.request.executionPolicy.worker ?? "pi-local",
        ws?.request.executionPolicy.model ?? "qwen2.5-coder:7b",
      );
      step(task, "REFLECTION");
      runReflection(task, result.output ?? result.summary);
    }
  }

  return {
    start(taskId: string) {
      const task = taskManager.getRow(taskId);
      if (!task) throw new Error(`task not found: ${taskId}`);
      run(task);
    },
    cancel(taskId: string) {
      const task = taskManager.getRow(taskId);
      if (!task || taskManager.isTerminal(task.status)) return;
      taskManager.updateStatus(taskId, "CANCELLED");
      runningStages.delete(taskId);
      researchState.delete(taskId);
      emitStage(taskId, taskManager.getRow(taskId)!);
      emit(taskId, { type: "done", status: "CANCELLED", ts: new Date().toISOString() });
    },
    approve(taskId: string) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "ASK_USER") return;
      taskManager.updateStatus(taskId, "PLANNING");
      emitStage(taskId, taskManager.getRow(taskId)!);
    },
    reportResearch(taskId, summary, stage1) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "RESEARCHING") return;
      runEvidenceValidation(task, summary, stage1);
    },
    reportVerificationFailure(taskId, output) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "VERIFYING") return;
      verificationFeedback.set(taskId, output);
      step(task, "REFLECTION");
      runReflection(task, output);
    },
    reportArtifactValidation(taskId, ok, reason) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "ARTIFACT_VALIDATION") return;
      if (!ok) {
        step(task, "REFLECTION");
        runReflection(task, reason ?? "artifact validation failed");
        return;
      }
      step(task, "VERIFYING");
      notifyVerificationRequired?.(taskId, task.workspace ?? undefined);
    },
    reportVerificationResult(taskId, ok, output) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "VERIFYING") return;
      if (ok) {
        step(task, "COMPLETE");
        return;
      }
      verificationFeedback.set(taskId, output);
      step(task, "REFLECTION");
      runReflection(task, output);
    },
    reportWorkerResult(taskId, result) {
      reportWorkerResult(taskId, result);
    },
    getStage(taskId: string) {
      return runningStages.get(taskId);
    },
  };
}
