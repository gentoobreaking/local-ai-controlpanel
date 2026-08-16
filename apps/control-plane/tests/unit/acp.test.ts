// ACP-Protocol Layer 單元測試（T034 §19）：
// handshake（create/resume）、event streaming（bus → ACP Event）、
// control 指令（Approve/Cancel/Retry/Escalate/InjectFeedback）、HTTP routes。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { createDb } from "../../src/db/index.js";
import { createTaskManager } from "../../src/task/task-manager.js";
import { createTaskBus } from "../../src/events/bus.js";
import { loadPolicies } from "../../src/policy/loader.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { createRunner } from "../../src/runner.js";
import { AcpServer, registerAcpRoutes } from "../../src/acp/server.js";
import { AcpClient } from "../../src/acp/client.js";
import type { StageEvent } from "../../src/events/bus.js";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;

let dir: string;
let acp: AcpServer;
let bus: ReturnType<typeof createTaskBus>;
let tm: ReturnType<typeof createTaskManager>;
let runner: ReturnType<typeof createRunner>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-acp-test-"));
  const db = createDb(dir);
  tm = createTaskManager(db);
  bus = createTaskBus();
  runner = createRunner(tm, bus, new PolicyEngine(loadPolicies(policiesDir)));
  acp = new AcpServer({ taskManager: tm, runner, bus, policyEngine: new PolicyEngine(loadPolicies(policiesDir)) });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("handshake：create + resume", async () => {
  const ack = await acp.handshake({
    type: "hello",
    protocolVersion: "0.6.0",
    clientName: "test-agent",
    clientVersion: "1.0",
  });
  assert.equal(ack.type, "hello_ack");
  assert.equal(ack.resumed, false);
  assert.ok(ack.sessionId);

  const resumed = await acp.handshake({
    type: "hello",
    protocolVersion: "0.6.0",
    clientName: "test-agent",
    clientVersion: "1.0",
    sessionId: ack.sessionId,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionId, ack.sessionId);
});

test("event streaming：runner 事件直接轉發為 ACP Event（StageChanged / EvidenceCollected / TaskCompleted）", async () => {
  const ack = await acp.handshake({ type: "hello", protocolVersion: "0.6.0", clientName: "t", clientVersion: "1" });
  const task = tm.create({ userRequest: "implement x" });

  // 手動觸發 bus 事件（runner stage / evidence / done）
  bus.emit(task.id, { type: "stage", stage: "ANALYZING", attempt: 1, ts: new Date().toISOString() });
  bus.emit(task.id, { type: "evidence", evidenceCount: 3, confidence: 0.8, ts: new Date().toISOString() });

  const events = await acp.poll(ack.sessionId);
  const kinds = events.map((e) => e.event.kind);
  assert.ok(kinds.includes("StageChanged"));
  assert.ok(kinds.includes("EvidenceCollected"));
  const stage = events.find((e) => e.event.kind === "StageChanged")?.event as
    | { kind: "StageChanged"; stage: string; attempt?: number }
    | undefined;
  assert.equal(stage?.stage, "ANALYZING");
  const seqs = events.map((e) => e.seq);
  assert.equal(seqs[1]! - seqs[0]!, 1);

  // long-poll 等待完成事件
  bus.emit(task.id, { type: "done", status: "COMPLETE", ts: new Date().toISOString() });
  const done = await acp.poll(ack.sessionId);
  assert.ok(done.some((e) => e.event.kind === "TaskCompleted"));
});

test("TaskCreated + PatchGenerated（進入 ARTIFACT_VALIDATION 時合成）", async () => {
  const ack = await acp.handshake({ type: "hello", protocolVersion: "0.6.0", clientName: "t", clientVersion: "1" });
  const resp = await acp.createTask({ type: "task_request", id: "r1", request: "hello" });
  assert.equal(resp.status, "accepted");
  assert.ok(resp.taskId);

  const events = await acp.poll(ack.sessionId);
  assert.ok(events.some((e) => e.event.kind === "TaskCreated"));

  // 進入 ARTIFACT_VALIDATION → PatchGenerated
  tm.addFlag(resp.taskId!, "f");
  const e: StageEvent = { type: "stage", stage: "ARTIFACT_VALIDATION", attempt: 1, ts: new Date().toISOString() };
  bus.emit(resp.taskId!, e);
  const more = await acp.poll(ack.sessionId);
  assert.ok(more.some((m) => m.event.kind === "PatchGenerated"));
});

test("control：Cancel / Retry / Escalate（NOT_SUPPORTED）/ InjectFeedback / Approve", async () => {
  const task = tm.create({ userRequest: "ctrl test" });

  // Cancel
  let ack = await acp.control({ type: "control", id: "c1", action: "Cancel", taskId: task.id });
  assert.equal(ack.accepted, true);
  assert.equal(tm.getRow(task.id)!.status, "CANCELLED");

  // Retry（CANCELLED → CREATED → runner start → RESEARCHING）
  ack = await acp.control({ type: "control", id: "c2", action: "Retry", taskId: task.id });
  assert.equal(ack.accepted, true);
  assert.equal(tm.getRow(task.id)!.status, "RESEARCHING");

  // Escalate：Phase 1–5 NOT_SUPPORTED
  ack = await acp.control({ type: "control", id: "c3", action: "Escalate", taskId: task.id });
  assert.equal(ack.accepted, false);
  assert.ok(ack.detail!.includes("Phase 1–5"));
  assert.ok(tm.getRow(task.id)!.flags.some((f) => f.startsWith("escalation:")));

  // InjectFeedback
  ack = await acp.control({
    type: "control",
    id: "c4",
    action: "InjectFeedback",
    taskId: task.id,
    payload: { feedback: "looks good" },
  });
  assert.equal(ack.accepted, true);
  assert.ok(tm.getRow(task.id)!.flags.some((f) => f.startsWith("feedback:")));

  // Approve：需 ASK_USER 狀態
  const task2 = tm.create({ userRequest: "blocked" });
  tm.updateStatus(task2.id, "ASK_USER");
  ack = await acp.control({ type: "control", id: "c5", action: "Approve", taskId: task2.id });
  assert.equal(ack.accepted, true);
  assert.equal(tm.getRow(task2.id)!.status, "PLANNING");

  // 不存在的任務
  ack = await acp.control({ type: "control", id: "c6", action: "Cancel", taskId: "TASK-NOPE" });
  assert.equal(ack.accepted, false);
  assert.ok(ack.detail!.includes("not found"));
});

test("heartbeat + terminate", async () => {
  const ack = await acp.handshake({ type: "hello", protocolVersion: "0.6.0", clientName: "t", clientVersion: "1" });
  acp.sessions.heartbeat(ack.sessionId);
  assert.equal(acp.sessions.get(ack.sessionId)!.terminated, false);
  assert.equal(acp.terminate(ack.sessionId), true);
  assert.equal(acp.sessions.resume(ack.sessionId), undefined);
});

test("HTTP routes + AcpClient：handshake → 委派任務 → poll 事件 → control", async () => {
  const app = Fastify({ logger: false });
  await app.register(async (a) => {
    registerAcpRoutes(a, acp);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;

  const client = new AcpClient({ baseUrl: `http://127.0.0.1:${port}` });
  const ack = await client.connect();
  assert.equal(ack.resumed, false);

  const task = await client.createTask({ request: "via acp client" });
  assert.equal(task.status, "accepted");
  assert.ok(task.taskId);

  const events = await client.poll();
  assert.ok(events.some((e) => e.event.kind === "TaskCreated"));
  assert.ok(events.some((e) => e.event.kind === "StageChanged"));

  const controlAck = await client.control({ action: "Cancel", taskId: task.taskId! });
  assert.equal(controlAck.accepted, true);

  const resumed = await client.connect(ack.sessionId);
  assert.equal(resumed.resumed, true);

  await client.terminate();
  await app.close();
});

test("GET /acp/health + /acp/sessions（Fastify inject）", async () => {
  const app = Fastify({ logger: false });
  await app.register(async (a) => {
    registerAcpRoutes(a, acp);
  });
  const health = await app.inject({ method: "GET", url: "/acp/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().protocol, "0.6.0");

  const sessions = await app.inject({ method: "GET", url: "/acp/sessions" });
  assert.equal(sessions.statusCode, 200);
  assert.ok(Array.isArray(sessions.json().sessions));
  await app.close();
});