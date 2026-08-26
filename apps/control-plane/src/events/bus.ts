// Task 事件（§45.5 SSE schema / §32 Observability）。
// 由 runner（state machine 轉移）與各引擎發出；SSE route 訂閱。

import { EventEmitter } from "node:events";

export type StageEvent =
  | { type: "stage"; stage: string; attempt?: number; ts: string }
  | { type: "evidence"; evidenceCount: number; confidence?: number; ts: string }
  | {
      type: "verification";
      verifier: string;
      status: string;
      sandbox?: string;
      durationMs?: number;
      output?: string;
      ts: string;
    }
  | {
      type: "search";
      round: number;
      maxRounds: number;
      sufficient: boolean;
      missing?: string[];
      queries?: Array<{ query: string; reason?: string }>;
      foundCount?: number;
      sources?: string[];
      evidence?: Array<{ title?: string; url?: string; snippet?: string }>;
      ts: string;
    }
  | { type: "reflection"; classification?: string; action?: string; ts: string }
  | { type: "done"; status: string; ts: string };

export interface TaskBus {
  on(taskId: string, listener: (e: StageEvent) => void): () => void;
  emit(taskId: string, event: StageEvent): void;
}

export function createTaskBus(): TaskBus {
  const emitter = new EventEmitter();
  return {
    on(taskId, listener) {
      emitter.on(taskId, listener);
      return () => emitter.off(taskId, listener);
    },
    emit(taskId, event) {
      emitter.emit(taskId, event);
    },
  };
}

export function stageEvent(stage: string, attempt?: number): StageEvent {
  return { type: "stage", stage, attempt, ts: new Date().toISOString() };
}
