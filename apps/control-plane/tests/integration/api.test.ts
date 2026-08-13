// API integration 測試（spec §45.5）：REST + SSE + 驗證。
// 使用 Fastify inject（不開 port）＋ fetch streaming（SSE）。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server.js";
import type { AppDeps } from "../../src/server.js";

let dir: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof buildApp>>["app"];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "acp-api-"));
  const built = await buildApp({ config: { host: "127.0.0.1", port: 0, dataDir: dir } });
  app = built.app;
  deps = built.deps;
});

afterEach(async () => {
  await app.close();
  deps.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/v1/tasks 建立並推進到 RESEARCH_REQUIRED（runner stub）", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "add kubernetes deployment support" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.id, "TASK-001");
  assert.equal(body.status, "RESEARCH_REQUIRED");
  assert.equal(body.attempt, 1);
  assert.equal(body.userRequest, "add kubernetes deployment support");
});

test("zod 驗證：空 userRequest → 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /api/v1/tasks 列表與 GET /:id 詳細", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "first" },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "second", sandboxMode: "seatbelt" },
  });

  const list = await app.inject({ method: "GET", url: "/api/v1/tasks" });
  assert.equal(list.statusCode, 200);
  const tasks = list.json();
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.id, "TASK-002");
  assert.equal(tasks[0]!.sandboxMode, "seatbelt");
  assert.equal(tasks[0]!.status, "RESEARCH_REQUIRED");

  const detail = await app.inject({ method: "GET", url: "/api/v1/tasks/TASK-001" });
  const d = detail.json();
  assert.equal(detail.statusCode, 200);
  assert.equal(d.id, "TASK-001");
  assert.equal(d.complexity, undefined);
  assert.ok(Array.isArray(d.flags));
});

test("404：不存在的 task", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/tasks/TASK-999" });
  assert.equal(res.statusCode, 404);
  const cancel = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/TASK-999/cancel",
  });
  assert.equal(cancel.statusCode, 404);
});

test("POST cancel 中斷執行 → CANCELLED（含 done 事件）", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "cancel me" },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/TASK-001/cancel",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "CANCELLED");

  const detail = await app.inject({ method: "GET", url: "/api/v1/tasks/TASK-001" });
  assert.equal(detail.json().status, "CANCELLED");
});

test("POST approve 記錄 approvals 並回傳", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "approve me" },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/TASK-001/approve",
    payload: { kind: "block", actor: "david", reason: "override" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().approved, true);
  const row = deps.db
    .prepare("SELECT kind, actor, reason FROM approvals WHERE task_id = ?")
    .get("TASK-001") as { kind: string; actor: string; reason: string };
  assert.equal(row.kind, "block");
  assert.equal(row.actor, "david");
  assert.equal(row.reason, "override");
});

test("GET /api/v1/sandbox 回傳四後端布林", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/sandbox" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  for (const k of ["bwrap", "seatbelt", "shuru", "docker"]) {
    assert.equal(typeof body[k], "boolean", `${k} should be boolean`);
  }
});

test("GET /api/v1/strategy/:id 回傳 local_only stub（§24）", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "strategy me" },
  });
  const res = await app.inject({ method: "GET", url: "/api/v1/strategy/TASK-001" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.strategy, "local_only");
  assert.equal(body.allowCloud, false);
  assert.equal(body.worker, "pi-local");
});

test("SSE：/api/v1/tasks/:id/events 串流 stage 事件（fetch streaming）", async () => {
  if (!app.server.listening) {
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  }
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "stream me" },
  });
  assert.equal(created.statusCode, 201);
  const taskId = created.json().id;

  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/v1/tasks/${taskId}/events`, {
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline && events.length < 5) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ") && !line.startsWith("data: :ping")) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
    }
  }
  ctrl.abort();

  assert.ok(events.length >= 1, "expected >=1 SSE event");
  const first = events[0] as { type: string; stage?: string };
  assert.equal(first.type, "stage");
  assert.ok(["ANALYZING", "POLICY_CHECK", "RESEARCH_REQUIRED"].includes(first.stage!));
});