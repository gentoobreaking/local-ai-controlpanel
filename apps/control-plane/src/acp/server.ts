// ACP Server（spec §19）：HTTP 長輪詢傳輸。
// - POST /acp/session       handshake（hello/hello_ack，可 resume）
// - POST /acp/poll          事件長輪詢（帶 ackSeq）
// - POST /acp/control       控制指令（Approve/Cancel/Retry/Escalate/InjectFeedback）
// - POST /acp/tasks         外部 runtime 委派任務（TaskRequest → runner）
// - GET  /acp/sessions      目前 session 清單
// runner 的 event bus 直接轉發為 ACP Event（§19：事件流整合）。

import type { FastifyInstance } from "fastify";
import type { PolicyEngine } from "../policy/engine.js";
import type { TaskManager } from "../task/task-manager.js";
import type { TaskRunner } from "../runner.js";
import type { StageEvent, TaskBus } from "../events/bus.js";
import {
  ACP_VERSION,
  acpEventFromStage,
  type AcpControl,
  type AcpControlAck,
  type AcpEventBase,
  type AcpHello,
  type AcpHelloAck,
  type AcpTaskRequest,
  type AcpTaskResponse,
} from "./protocol.js";
import { AcpSessionManager } from "./session.js";

export interface AcpServerOptions {
  taskManager: TaskManager;
  runner: TaskRunner;
  bus: TaskBus;
  policyEngine: PolicyEngine;
  /** 長輪詢等待上限（ms） */
  pollTimeoutMs?: number;
  /** 每次 poll 最多事件數 */
  pollLimit?: number;
  serverName?: string;
  serverVersion?: string;
}

export class AcpServer {
  readonly sessions = new AcpSessionManager();
  private readonly opts: AcpServerOptions;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(opts: AcpServerOptions) {
    this.opts = opts;
    this.subscribeAllTasks();
  }

  // ---- §19：event bus 直接轉發為 ACP Event ----

  private subscribeAllTasks(): void {
    // 全域訂閱：任何 task 的事件轉發到所有存活 session
    const bus = this.opts.bus;
    const origEmit = bus.emit.bind(bus);
    bus.emit = (taskId: string, e: StageEvent) => {
      origEmit(taskId, e);
      this.broadcast(taskId, e);
    };
  }

  private broadcast(taskId: string, e: StageEvent): void {
    const sessions = this.sessions.list().filter((s) => !s.terminated);
    if (sessions.length === 0) return;
    // PatchGenerated：runner 產出 patch 進入 ARTIFACT_VALIDATION 時一併發出
    if (e.type === "stage" && e.stage === "ARTIFACT_VALIDATION") {
      const task = this.opts.taskManager.getRow(taskId);
      this.dispatchEvent(taskId, {
        type: "event",
        id: `evt-${taskId}-patch`,
        taskId,
        ts: new Date().toISOString(),
        seq: 0,
        event: { kind: "PatchGenerated", summary: task?.request.slice(0, 80) },
      });
    }
    for (const session of sessions) {
      const seq = this.sessions.nextSeq(session.id);
      const acpEvent = acpEventFromStage(taskId, e, seq);
      this.sessions.append(session.id, acpEvent);
      this.wake(session.id);
    }
  }

  /** TaskCreated 事件（ACP 建立任務時由 server 發出）。 */
  private dispatchTaskCreated(taskId: string): void {
    for (const session of this.sessions.list().filter((s) => !s.terminated)) {
      const seq = this.sessions.nextSeq(session.id);
      const ev: AcpEventBase = {
        type: "event",
        id: `evt-${taskId}-created-${seq}`,
        taskId,
        ts: new Date().toISOString(),
        seq,
        event: { kind: "TaskCreated", attempt: 1 },
      };
      this.sessions.append(session.id, ev);
      this.wake(session.id);
    }
  }

  private dispatchEvent(taskId: string, e: AcpEventBase): void {
    for (const session of this.sessions.list().filter((s) => !s.terminated)) {
      const seq = this.sessions.nextSeq(session.id);
      this.sessions.append(session.id, { ...e, seq });
      this.wake(session.id);
    }
  }

  private wake(sessionId: string): void {
    const waiters = this.waiters.get(sessionId);
    if (!waiters) return;
    for (const w of waiters) w();
    waiters.clear();
  }

  // ---- handshake ----

  async handshake(hello: AcpHello): Promise<AcpHelloAck> {
    if (hello.type !== "hello") throw new Error("expected hello");
    if (hello.sessionId) {
      const resumed = this.sessions.resume(hello.sessionId);
      if (resumed) {
        return {
          type: "hello_ack",
          protocolVersion: ACP_VERSION,
          serverName: this.opts.serverName ?? "acp-control-plane",
          serverVersion: this.opts.serverVersion ?? ACP_VERSION,
          sessionId: hello.sessionId,
          resumed: true,
          nextSeq: this.sessions.nextSeq(hello.sessionId),
        };
      }
    }
    const session = this.sessions.create(hello.clientName, hello.clientVersion);
    return {
      type: "hello_ack",
      protocolVersion: ACP_VERSION,
      serverName: this.opts.serverName ?? "acp-control-plane",
      serverVersion: this.opts.serverVersion ?? ACP_VERSION,
      sessionId: session.id,
      resumed: false,
      nextSeq: 1,
    };
  }

  // ---- long-poll ----

  /** 長輪詢：先回傳既有事件；無事件時等待至 timeout。 */
  async poll(sessionId: string, opts: { ackSeq?: number; limit?: number } = {}): Promise<AcpEventBase[]> {
    const session = this.sessions.resume(sessionId);
    if (!session) throw new Error("session not found or terminated");
    if (opts.ackSeq !== undefined) this.sessions.ack(sessionId, opts.ackSeq);

    const existing = this.sessions.drain(sessionId, opts.limit ?? this.opts.pollLimit ?? 50);
    if (existing.length > 0) return existing;

    // resume replay：已 ack 之後尚未送出的 seq（session 重啟時 client 傳 ackSeq）
    if (opts.ackSeq !== undefined && session.lastSentSeq > opts.ackSeq) {
      // drain 已處理（queue 仍持有未 pop 的），此分支為保險
    }

    const timeout = this.opts.pollTimeoutMs ?? 25_000;
    return await new Promise<AcpEventBase[]>((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      this.waiters.set(sessionId, waiters);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        waiters.delete(finish);
        resolve([]);
      }, timeout);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(this.sessions.drain(sessionId, opts.limit ?? this.opts.pollLimit ?? 50));
      };
      waiters.add(finish);
    });
  }

  // ---- control 指令 ----

  /** §19 控制指令：Approve / Cancel / Retry / Escalate / InjectFeedback。 */
  async control(ctrl: AcpControl): Promise<AcpControlAck> {
    const { taskManager, runner, policyEngine } = this.opts;
    const base = { type: "control_ack" as const, id: ctrl.id, taskId: ctrl.taskId, action: ctrl.action };

    const task = taskManager.getRow(ctrl.taskId);
    if (!task) {
      return { ...base, accepted: false, detail: `task not found: ${ctrl.taskId}` };
    }

    switch (ctrl.action) {
      case "Approve": {
        if (task.status !== "ASK_USER") {
          return { ...base, accepted: false, detail: `status ${task.status} 不需 approve` };
        }
        taskManager.recordApproval(
          ctrl.taskId,
          "block",
          String(ctrl.payload?.actor ?? "acp"),
          ctrl.payload?.reason ? String(ctrl.payload.reason) : undefined,
        );
        runner.approve(ctrl.taskId);
        return { ...base, accepted: true, detail: "approved" };
      }
      case "Cancel": {
        if (taskManager.isTerminal(task.status)) {
          return { ...base, accepted: false, detail: `already terminal (${task.status})` };
        }
        runner.cancel(ctrl.taskId);
        return { ...base, accepted: true, detail: "cancelled" };
      }
      case "Retry": {
        if (task.status === "COMPLETE") {
          return { ...base, accepted: false, detail: "COMPLETE 任務不可 retry" };
        }
        taskManager.updateStatus(ctrl.taskId, "CREATED");
        runner.start(ctrl.taskId);
        return { ...base, accepted: true, detail: "retried" };
      }
      case "Escalate": {
        // Phase 1–5：escalation 停用（§25），僅記錄 + 回報 NOT_SUPPORTED
        const taskRow = taskManager.getRow(ctrl.taskId);
        const decision = policyEngine.evaluateEscalation({
          attempt: taskRow?.attempt ?? 1,
          failureClassification: taskRow?.flags.find(f => f.startsWith("reflection:"))?.split(":")[1],
          localHistory: [],
          analysis: { complexity: "medium", risk: "medium" } as any,
        });
        taskManager.recordApproval(
          ctrl.taskId,
          "escalation",
          String(ctrl.payload?.actor ?? "acp"),
          decision.reason,
        );
        taskManager.addFlag(ctrl.taskId, `escalation:${decision.type}`);
        return { ...base, accepted: false, detail: decision.reason };
      }
      case "InjectFeedback": {
        const feedback = ctrl.payload?.feedback ? String(ctrl.payload.feedback) : "";
        if (!feedback) return { ...base, accepted: false, detail: "缺少 payload.feedback" };
        taskManager.addFlag(ctrl.taskId, `feedback:${feedback.slice(0, 200)}`);
        return { ...base, accepted: true, detail: `feedback 已注入（attempt ${task.attempt}）` };
      }
      default:
        return { ...base, accepted: false, detail: `unknown action: ${String(ctrl.action)}` };
    }
  }

  /** §19：建立任務（外部 runtime 委派）。 */
  async createTask(req: AcpTaskRequest): Promise<AcpTaskResponse> {
    if (req.type !== "task_request") throw new Error("expected task_request");
    const task = this.opts.taskManager.create({
      userRequest: req.request,
      workspace: req.workspace,
      sandboxMode: req.sandboxMode,
      complexity: req.complexity,
      risk: req.risk,
    });
    this.dispatchTaskCreated(task.id);
    this.opts.runner.start(task.id);
    return { type: "task_response", id: req.id, taskId: task.id, status: "accepted" };
  }

  terminate(sessionId: string): boolean {
    return this.sessions.terminate(sessionId);
  }
}

// ---- Fastify routes ----

export interface AcpRouteDeps {
  taskManager: TaskManager;
  runner: TaskRunner;
  bus: TaskBus;
  policyEngine: PolicyEngine;
}

export function registerAcpRoutes(
  app: FastifyInstance,
  server: AcpServer,
): void {
  app.get("/acp/sessions", async () => ({
    sessions: server.sessions.list().map((s) => ({
      id: s.id,
      client: `${s.clientName}@${s.clientVersion}`,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      lastAckSeq: s.lastAckSeq,
      queued: s.queue.length,
      terminated: s.terminated,
    })),
  }));

  app.post("/acp/session", async (req, reply) => {
    const hello = req.body as AcpHello;
    if (!hello || hello.type !== "hello") {
      return reply.code(400).send({ error: "expected hello" });
    }
    try {
      return await server.handshake(hello);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post("/acp/poll", async (req, reply) => {
    const body = (req.body ?? {}) as { sessionId?: string; ackSeq?: number; limit?: number };
    if (!body.sessionId) return reply.code(400).send({ error: "缺少 sessionId" });
    try {
      const events = await server.poll(body.sessionId, {
        ackSeq: body.ackSeq,
        limit: body.limit,
      });
      return { sessionId: body.sessionId, events };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.post("/acp/control", async (req, reply) => {
    const ctrl = req.body as AcpControl;
    if (!ctrl || ctrl.type !== "control") {
      return reply.code(400).send({ error: "expected control" });
    }
    const ack = await server.control(ctrl);
    return reply.code(ack.accepted ? 200 : 422).send(ack);
  });

  app.post("/acp/tasks", async (req, reply) => {
    const taskReq = req.body as AcpTaskRequest;
    if (!taskReq || taskReq.type !== "task_request" || !taskReq.request) {
      return reply.code(400).send({ error: "expected task_request with request" });
    }
    try {
      return await server.createTask(taskReq);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post("/acp/heartbeat", async (req, reply) => {
    const body = (req.body ?? {}) as { sessionId?: string };
    if (!body.sessionId) return reply.code(400).send({ error: "缺少 sessionId" });
    if (!server.sessions.resume(body.sessionId)) {
      return reply.code(404).send({ error: "session not found or terminated" });
    }
    return { sessionId: body.sessionId, ts: new Date().toISOString() };
  });

  app.post("/acp/session/terminate", async (req, reply) => {
    const body = (req.body ?? {}) as { sessionId?: string };
    if (!body.sessionId) return reply.code(400).send({ error: "缺少 sessionId" });
    const ok = server.terminate(body.sessionId);
    return reply.code(ok ? 200 : 404).send({ terminated: ok });
  });

  app.get("/acp/health", async () => ({
    status: "ok",
    protocol: ACP_VERSION,
    sessions: server.sessions.list().length,
  }));
}