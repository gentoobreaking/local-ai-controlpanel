// Task Runner（T008 stub → T010 Policy → T017/T018/T019/T020 接入）。
// 以 state machine 驅動 task：POLICY_CHECK 以 §10 Knowledge Policy 決定
// 是否需要研究；RESEARCH_REQUIRED 等待 Research Engine（HTTP，T017）；
// EVIDENCE_VALIDATION 由 Evidence Gate（T019）四分支決策；
// REFLECTION（T020）分類失敗 → retry/research/ask_user/stop。
// emit SSE stage 事件、支援 cancel / approve。

import { createStateMachine } from "./state/state-machine.js";
import type { PolicyEngine } from "./policy/engine.js";
import type { StageEvent, TaskBus } from "./events/bus.js";
import type { TaskManager } from "./task/task-manager.js";
import type { TaskRow, TaskStatus } from "./task/types.js";
import { classify, canRetry } from "./reflection/engine.js";
import type { EvidenceDecision } from "./evidence/gate.js";
import { validateEvidenceGate } from "./evidence/gate.js";
import type { ResearchSummary } from "./policy/types.js";

export interface TaskRunner {
  start(taskId: string): void;
  cancel(taskId: string): void;
  approve(taskId: string): void;
  /** 回報 research 完成結果（由 research 整合層呼叫，T017/T019 接入）。 */
  reportResearch(taskId: string, summary: ResearchSummary, stage1: "COMPLETE" | "PARTIAL" | "FAILED"): void;
  /** 回報 verification 失敗（T020 接入 reflection）。 */
  reportVerificationFailure(taskId: string, output: string): void;
  /** 目前進行的階段（供 SSE 重連 replay 快照）。 */
  getStage(taskId: string): { stage: TaskStatus; attempt: number } | undefined;
}

export function createRunner(
  taskManager: TaskManager,
  bus: TaskBus,
  policyEngine: PolicyEngine,
): TaskRunner {
  const runningStages = new Map<string, { stage: TaskStatus; attempt: number }>();
  const researchState = new Map<string, { retries: number; task: TaskRow }>();
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
        break;
      case "RESEARCH_AGAIN": {
        const nextRetries = retries + 1;
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
        } else {
          step(task, "STOP");
        }
        break;
      case "research":
        step(task, "RESEARCH_REQUIRED");
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
          } else {
            // 研究需求確定 → 立即啟動 research（進入 RESEARCHING 等待 reportResearch）
            researchState.set(task.id, { retries: 0, task });
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
      step(task, "REFLECTION");
      runReflection(task, output);
    },
    getStage(taskId: string) {
      return runningStages.get(taskId);
    },
  };
}
