// ACP-Protocol 訊息定義（spec §19：Control Plane ↕ Agent Runtime）。
// 用於任務控制/事件流（與 MCP 的「工具/資源存取」不同層）。
// 訊息分四類：TaskRequest、TaskResponse、Event、Control。

export const ACP_VERSION = "0.6.0";

// ---- TaskRequest（Control Plane → Agent：建立/指派任務）----

export interface AcpTaskRequest {
  type: "task_request";
  id: string;
  request: string;
  workspace?: string;
  sandboxMode?: "auto" | "bwrap" | "seatbelt" | "shuru" | "docker";
  complexity?: "low" | "medium" | "high";
  risk?: "low" | "medium" | "high";
  metadata?: Record<string, string>;
}

// ---- TaskResponse（Agent → Control Plane：任務接受/拒絕/狀態）----

export type TaskResponseStatus = "accepted" | "rejected" | "running" | "complete" | "failed";

export interface AcpTaskResponse {
  type: "task_response";
  id: string;
  taskId?: string;
  status: TaskResponseStatus;
  detail?: string;
}

// ---- Event（Agent → Control Plane：任務事件流）----

export interface AcpEventBase {
  type: "event";
  id: string;
  taskId: string;
  ts: string;
  /** 事件序號（session 內單調遞增，供 long-poll ack/replay） */
  seq: number;
  event: AcpEventBody;
}

export type AcpEventBody =
  | { kind: "TaskCreated"; attempt?: number }
  | { kind: "StageChanged"; stage: string; attempt?: number }
  | { kind: "EvidenceCollected"; evidenceCount: number; confidence?: number }
  | { kind: "PatchGenerated"; files?: string; summary?: string }
  | { kind: "VerificationCompleted"; verifier: string; status: string; sandbox?: string; durationMs?: number }
  | { kind: "ReflectionTriggered"; classification?: string; action?: string }
  | { kind: "TaskCompleted"; status: string };

// ---- Control（Control Plane → Agent：控制指令）----

export type AcpControlAction =
  | "Approve"
  | "Cancel"
  | "Retry"
  | "Escalate"
  | "InjectFeedback";

export interface AcpControl {
  type: "control";
  id: string;
  action: AcpControlAction;
  taskId: string;
  /** action 專用參數（InjectFeedback 的 feedback、Approve 的 reason/actor…） */
  payload?: Record<string, unknown>;
}

export interface AcpControlAck {
  type: "control_ack";
  id: string;
  taskId: string;
  action: AcpControlAction;
  accepted: boolean;
  detail?: string;
}

// ---- handshake（§19：session 建立）----

export interface AcpHello {
  type: "hello";
  protocolVersion: string;
  clientName: string;
  clientVersion: string;
  /** 續接已存在的 session（resume） */
  sessionId?: string;
}

export interface AcpHelloAck {
  type: "hello_ack";
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  sessionId: string;
  resumed: boolean;
  /** resume 時從下一個未確認 seq 開始 replay */
  nextSeq?: number;
}

// ---- heartbeat（§19：session 保活）----

export interface AcpHeartbeat {
  type: "heartbeat";
  sessionId: string;
  ts: string;
}

// ---- 對應 Control Plane 既有事件（events/bus.ts StageEvent）----

import type { StageEvent } from "../events/bus.js";

export function acpEventFromStage(taskId: string, e: StageEvent, seq: number): AcpEventBase {
  const base = { type: "event" as const, id: `evt-${seq}`, taskId, ts: e.ts ?? new Date().toISOString(), seq };
  switch (e.type) {
    case "stage":
      return { ...base, event: { kind: "StageChanged", stage: e.stage, attempt: e.attempt } };
    case "evidence":
      return { ...base, event: { kind: "EvidenceCollected", evidenceCount: e.evidenceCount, confidence: e.confidence } };
    case "verification":
      return {
        ...base,
        event: {
          kind: "VerificationCompleted",
          verifier: e.verifier,
          status: e.status,
          sandbox: e.sandbox,
          durationMs: e.durationMs,
        },
      };
    case "reflection":
      return { ...base, event: { kind: "ReflectionTriggered", classification: e.classification, action: e.action } };
    case "done":
      return { ...base, event: { kind: "TaskCompleted", status: e.status } };
    default:
      return { ...base, event: { kind: "StageChanged", stage: "UNKNOWN" } };
  }
}