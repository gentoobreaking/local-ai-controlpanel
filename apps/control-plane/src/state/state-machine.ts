// Task 狀態機（spec §9）。
// 純 logic 模組：不碰 DB / 網路。Phase 1–5 無 ESCALATE 分支。

import type { TaskStatus } from "../task/types.js";

/** 終態：到達後不可再轉移。 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "COMPLETE",
  "STOP",
  "CANCELLED",
]);

/** §9 轉移表（Phase 1–5 版本）。 */
export const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  CREATED: new Set(["ANALYZING", "CANCELLED"]),
  ANALYZING: new Set(["POLICY_CHECK", "CANCELLED"]),
  POLICY_CHECK: new Set(["RESEARCH_REQUIRED", "PLANNING", "CANCELLED"]),
  RESEARCH_REQUIRED: new Set(["RESEARCHING", "CANCELLED"]),
  RESEARCHING: new Set(["EVIDENCE_VALIDATION", "CANCELLED"]),
  // EVIDENCE_VALIDATION 四分支（§9 / §14）：
  // PASS → PLANNING；RESEARCH_AGAIN → RESEARCHING；
  // BLOCK → ASK_USER / STOP（知識缺口，硬性）；DEGRADED → PLANNING（帶旗標）
  EVIDENCE_VALIDATION: new Set([
    "PLANNING",
    "RESEARCHING",
    "ASK_USER",
    "STOP",
    "CANCELLED",
  ]),
  PLANNING: new Set(["WORKER_SELECTION", "CANCELLED"]),
  WORKER_SELECTION: new Set(["SEARCHING", "IMPLEMENTING", "CANCELLED"]),
  // Agentic 搜尋迴圈：模型自評證據缺口 → 迭代查詢；到頂/足夠 → IMPLEMENTING
  SEARCHING: new Set(["IMPLEMENTING", "REFLECTION", "CANCELLED"]),
  IMPLEMENTING: new Set(["ARTIFACT_VALIDATION", "REFLECTION", "CANCELLED"]),
  ARTIFACT_VALIDATION: new Set(["VERIFYING", "REFLECTION", "CANCELLED"]),
  VERIFYING: new Set(["COMPLETE", "REFLECTION", "CANCELLED"]),
  // REFLECTION 動作（§22/§23，Phase 1–5）：
  // coding_error → retry（IMPLEMENTING）；knowledge_error → research（RESEARCH_REQUIRED）；
  // requirement_error → ask_user（ASK_USER）；environment_error → repair（ARTIFACT_VALIDATION）；
  // model_limitation → STOP
  REFLECTION: new Set([
    "IMPLEMENTING",
    "RESEARCH_REQUIRED",
    "ASK_USER",
    "ARTIFACT_VALIDATION",
    "STOP",
    "CANCELLED",
  ]),
  // ASK_USER 等待 approve：批准 → PLANNING；拒絕/無法滿足 → STOP
  ASK_USER: new Set(["PLANNING", "STOP", "CANCELLED"]),
  COMPLETE: new Set(),
  STOP: new Set(),
  CANCELLED: new Set(),
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`invalid state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionRecord {
  from: TaskStatus;
  to: TaskStatus;
  ts: string;
}

export class StateMachine {
  private current: TaskStatus;
  /** 轉移歷史（in-memory，供 event log / Observability §32）。 */
  private readonly history_: TransitionRecord[] = [];

  constructor(initial: TaskStatus) {
    this.current = initial;
  }

  get state(): TaskStatus {
    return this.current;
  }

  get history(): readonly TransitionRecord[] {
    return this.history_;
  }

  canTransition(to: TaskStatus): boolean {
    return TRANSITIONS[this.current]?.has(to) ?? false;
  }

  /** 驗證並更新狀態；非法轉移拋 InvalidTransitionError。回傳新狀態。 */
  transition(to: TaskStatus): TaskStatus {
    if (!this.canTransition(to)) throw new InvalidTransitionError(this.current, to);
    this.history_.push({ from: this.current, to, ts: new Date().toISOString() });
    this.current = to;
    return to;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.current);
  }
}

/** 固定初始狀態（讀取既有 task 時可用其目前狀態重建）。 */
export function createStateMachine(initial: TaskStatus = "CREATED"): StateMachine {
  return new StateMachine(initial);
}
