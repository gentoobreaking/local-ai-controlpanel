import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../src/db/index.js";
import { createTaskManager } from "../../src/task/task-manager.js";

let dir: string;
let db: ReturnType<typeof createDb>;
let manager: ReturnType<typeof createTaskManager>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-test-"));
  db = createDb(dir);
  manager = createTaskManager(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("create 產生序號 id 與初始狀態", () => {
  const t1 = manager.create({ userRequest: "add feature X" });
  const t2 = manager.create({ userRequest: "fix bug Y", sandboxMode: "seatbelt" });

  assert.equal(t1.id, "TASK-001");
  assert.equal(t1.status, "CREATED");
  assert.equal(t1.attempt, 1);
  assert.equal(t1.request, "add feature X");

  assert.equal(t2.id, "TASK-002");
  assert.equal(t2.sandboxMode, "seatbelt");
  assert.ok(t1.createdAt <= t2.createdAt);
});

test("list 依 created_at 反序", () => {
  manager.create({ userRequest: "first" });
  manager.create({ userRequest: "second" });
  const rows = manager.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.request, "second");
  assert.equal(rows[1]!.request, "first");
});

test("updateStatus / setAttempt / addFlag 更新並觸發 updatedAt", () => {
  const t = manager.create({ userRequest: "x" });
  const before = t.updatedAt;
  const moved = manager.updateStatus(t.id, "ANALYZING");
  assert.equal(moved.status, "ANALYZING");
  assert.ok(moved.updatedAt >= before);

  const attempted = manager.setAttempt(t.id, 2);
  assert.equal(attempted.attempt, 2);

  const flagged = manager.addFlag(t.id, "degraded");
  assert.deepEqual(flagged.flags, ["degraded"]);
  assert.deepEqual(manager.addFlag(t.id, "degraded").flags, ["degraded"]);
});

test("isTerminal 判定", () => {
  assert.ok(manager.isTerminal("COMPLETE"));
  assert.ok(manager.isTerminal("STOP"));
  assert.ok(manager.isTerminal("CANCELLED"));
  assert.ok(!manager.isTerminal("CREATED"));
  assert.ok(!manager.isTerminal("VERIFYING"));
});

test("不存在的 task 操作拋錯", () => {
  assert.throws(() => manager.updateStatus("TASK-999", "ANALYZING"), /task not found/);
  assert.equal(manager.getRow("TASK-999"), undefined);
});

test("關聯查詢：evidenceCount / verificationSummary / recordAttempt", () => {
  const t = manager.create({ userRequest: "y" });

  assert.deepEqual(manager.evidenceCount(t.id), { count: 0, confidence: null });
  assert.equal(manager.verificationSummary(t.id), undefined);

  db.prepare(
    `INSERT INTO evidence (id, task_id, claim, source_uri, source_type, confidence, relevance, created_at)
     VALUES ('e1', ?, 'claim', 'https://example.com', 'official', 0.96, 0.9, ?)`,
  ).run(t.id, new Date().toISOString());
  assert.deepEqual(manager.evidenceCount(t.id), { count: 1, confidence: 0.96 });

  db.prepare(
    `INSERT INTO verification_results (id, task_id, verifier, status, output, sandbox_mode, duration_ms, created_at)
     VALUES ('v1', ?, 'pytest', 'FAIL', 'out', 'seatbelt', 1200, ?)`,
  ).run(t.id, new Date().toISOString());
  assert.deepEqual(manager.verificationSummary(t.id), {
    verifier: "pytest",
    status: "FAIL",
    sandbox: "seatbelt",
    durationMs: 1200,
  });

  manager.recordAttempt(t.id, 1, "pi-local", "qwen-9b");
  const attempts = db.prepare("SELECT * FROM attempts").all();
  assert.equal(attempts.length, 1);
});

test("FTS5 虛擬表可用（evidence_fts 查詢）", () => {
  manager.create({ userRequest: "k8s" });
  const rows = db
    .prepare("SELECT 1 AS ok FROM evidence_fts LIMIT 0")
    .all();
  assert.ok(Array.isArray(rows));
});
