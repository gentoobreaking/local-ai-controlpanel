// Reflection Engine 測試（T020，spec §22/§23/§36.2）：
// 失敗分類器 + 動作建議 + retry policy + reflections 表記錄。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_BY_CLASS,
  canRetry,
  classify,
  resolveRetryAction,
  scanSignatures,
  type FailureClass,
} from "../../src/reflection/engine.js";
import { createDb } from "../../src/db/index.js";
import { TaskManager } from "../../src/task/task-manager.js";

test("coding_error：TypeError / SyntaxError 命中", () => {
  const r = classify({ output: "TypeError: Cannot read properties of undefined" });
  assert.equal(r.classification, "coding_error");
  assert.equal(r.recommendedAction, "retry");
  assert.ok(r.confidence > 0.5);
});

test("knowledge_error：ModuleNotFoundError → research", () => {
  const r = classify({ output: "ModuleNotFoundError: No module named 'requests'" });
  assert.equal(r.classification, "knowledge_error");
  assert.equal(r.recommendedAction, "research");
  assert.ok(r.matchedSignatures.includes("ModuleNotFoundError"));
});

test("requirement_error：需求矛盾 → ask_user", () => {
  const r = classify({ output: "result does not meet requirement: output schema mismatch" });
  assert.equal(r.classification, "requirement_error");
  assert.equal(r.recommendedAction, "ask_user");
});

test("environment_error：command not found → repair_environment", () => {
  const r = classify({ output: "bash: rustc: command not found" });
  assert.equal(r.classification, "environment_error");
  assert.equal(r.recommendedAction, "repair_environment");
});

test("tool_error：sandbox timeout → retry", () => {
  const r = classify({ output: "sandbox run timed out after 120s" });
  assert.equal(r.classification, "tool_error");
  assert.equal(r.recommendedAction, "retry");
});

test("model_limitation：truncated output → stop（Phase 1–5，§24）", () => {
  const r = classify({ output: "output truncated: max tokens reached" });
  assert.equal(r.classification, "model_limitation");
  assert.equal(r.recommendedAction, "stop");
});

test("無命中 → 保守分類 coding_error（低信心）", () => {
  const r = classify({ output: "some totally unrelated message" });
  assert.equal(r.classification, "coding_error");
  assert.equal(r.confidence, 0.3);
  assert.deepEqual(r.matchedSignatures, []);
});

test("多 class 命中 → 命中數最多者勝出", () => {
  // 2 個 knowledge signatures vs 1 個 coding signature
  const r = classify({
    output: "ModuleNotFoundError: No module named 'x'\nCannot find package 'y'\nSyntaxError near line 3",
  });
  assert.equal(r.classification, "knowledge_error");
});

test("scanSignatures 回傳每 class 命中數", () => {
  const hits = scanSignatures("ModuleNotFoundError and EACCES permission denied");
  assert.equal(hits.get("knowledge_error"), 1);
  assert.equal(hits.get("environment_error"), 2); // EACCES + permission denied
});

test("ACTION_BY_CLASS 完整映射（§23）", () => {
  assert.deepEqual(ACTION_BY_CLASS, {
    coding_error: "retry",
    knowledge_error: "research",
    requirement_error: "ask_user",
    environment_error: "repair_environment",
    tool_error: "retry",
    model_limitation: "stop",
  });
});

test("resolveRetryAction：policy on 表優先，缺省用預設", () => {
  const policyOn: Partial<Record<FailureClass, "retry" | "research" | "ask_user" | "repair_environment" | "stop">> = {
    coding_error: "research", // policy 覆寫預設
  };
  assert.equal(resolveRetryAction("coding_error", policyOn), "research");
  assert.equal(resolveRetryAction("knowledge_error", policyOn), "research");
  assert.equal(resolveRetryAction("model_limitation", policyOn), "stop");
});

test("canRetry：max_attempts=3 限制生效", () => {
  assert.ok(canRetry(0, 3));
  assert.ok(canRetry(2, 3));
  assert.ok(!canRetry(3, 3));
  assert.ok(!canRetry(4, 3));
});

test("recordReflection 寫入 reflections 表 + lastReflection 查詢（§27 / §36.2）", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-refl-"));
  const db = createDb(dir);
  const tm = new TaskManager(db);
  const t = tm.create({ userRequest: "fix build" });
  tm.recordReflection(t.id, 1, "knowledge_error", 0.8, "research");
  const last = tm.lastReflection(t.id);
  assert.ok(last);
  assert.equal(last!.classification, "knowledge_error");
  assert.equal(last!.confidence, 0.8);
  assert.equal(last!.recommendedAction, "research");
});
