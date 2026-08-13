// Task Runner（T008 stub 版）。
// 以 state machine 驅動 task：本階段 pipeline 走到 RESEARCH_REQUIRED 即等待
//（Research Engine 於 T017 實作）；emit SSE stage 事件、支援 cancel。
// 實作層（Policy/Artifact/Verification/Sandbox）由 T010/T011/T012/T016 接入。

import { createStateMachine } from "./state/state-machine.js";
import type { StageEvent, TaskBus } from "./events/bus.js";
import type { TaskManager } from "./task/task-manager.js";
import type { TaskRow, TaskStatus } from "./task/types.js";

export interface TaskRunner {
  start(taskId: string): void;
  cancel(taskId: string): void;
  approve(taskId: string): void;
  /** 目前進行的階段（供 SSE 重連 replay 快照）。 */
  getStage(taskId: string): { stage: TaskStatus; attempt: number } | undefined;
}

export function createRunner(
  taskManager: TaskManager,
  bus: TaskBus,
): TaskRunner {
  const runningStages = new Map<string, { stage: TaskStatus; attempt: number }>();
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

  function run(task: TaskRow): void {
    if (taskManager.isTerminal(task.status)) return;
    const sm = createStateMachine(task.status);

    const step = (next: TaskStatus) => {
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
    };

    // 最小 pipeline（§38 Phase 1 驗證：Task → Policy → Research 邊界）。
    // ANALYZING / POLICY_CHECK 之後到達 RESEARCH_REQUIRED 等待 Research Engine。
    switch (sm.state) {
      case "CREATED":
        step("ANALYZING");
        step("POLICY_CHECK");
        step("RESEARCH_REQUIRED");
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
      const sm = createStateMachine(task.status);
      sm.transition("CANCELLED");
      const updated = taskManager.updateStatus(taskId, "CANCELLED");
      runningStages.delete(taskId);
      emitStage(taskId, updated);
      emit(taskId, { type: "done", status: "CANCELLED", ts: new Date().toISOString() });
    },
    approve(taskId: string) {
      const task = taskManager.getRow(taskId);
      if (!task || task.status !== "ASK_USER") return;
      taskManager.updateStatus(taskId, "PLANNING");
      emitStage(taskId, taskManager.getRow(taskId)!);
    },
    getStage(taskId: string) {
      return runningStages.get(taskId);
    },
  };
}
