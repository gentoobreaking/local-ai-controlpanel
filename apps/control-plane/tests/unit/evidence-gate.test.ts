// Evidence Gate 測試（T019，spec §14）：兩階段評估 + 降級政策 + 卡死防護。
// 全部確定性規則（無 LLM）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicies } from "../../src/policy/loader.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { validateEvidenceGate } from "../../src/evidence/gate.js";
import { createDb } from "../../src/db/index.js";
import { TaskManager } from "../../src/task/task-manager.js";
import type { ResearchSummary } from "../../src/policy/types.js";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;
const loaded = loadPolicies(policiesDir);
const engine = new PolicyEngine(loaded);

const summary = (over: Partial<ResearchSummary> = {}): ResearchSummary => ({
  facts: 3,
  sourcesCount: 2,
  officialSources: 1,
  ...over,
});

test("COMPLETE + SUFFICIENT → PASS", () => {
  const d = validateEvidenceGate(
    { stage1: "COMPLETE", summary: summary(), risk: "medium" },
    engine,
  );
  assert.equal(d.status, "PASS");
  assert.equal(d.stage1, "COMPLETE");
  assert.equal(d.stage2, "SUFFICIENT");
  assert.equal(d.blocks, 0);
});

test("COMPLETE + INSUFFICIENT（來源不足）→ BLOCK，永不降級", () => {
  const d = validateEvidenceGate(
    { stage1: "COMPLETE", summary: summary({ sourcesCount: 1, facts: 2 }), risk: "low" },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.equal(d.stage2, "INSUFFICIENT");
  assert.match(d.reason, /knowledge_gap/);
  assert.equal(d.blocks, 1);
});

test("COMPLETE + 零證據 → BLOCK（INSUFFICIENT_LOW_CONFIDENCE）", () => {
  const d = validateEvidenceGate(
    { stage1: "COMPLETE", summary: summary({ facts: 0, sourcesCount: 0 }), risk: "low" },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.equal(d.stage2, "INSUFFICIENT_LOW_CONFIDENCE");
  assert.match(d.reason, /low_confidence/);
});

test("PARTIAL + 未達重試上限 → RESEARCH_AGAIN（卡死防護）", () => {
  const d = validateEvidenceGate(
    { stage1: "PARTIAL", summary: summary(), risk: "low", researchRetries: 0 },
    engine,
  );
  assert.equal(d.status, "RESEARCH_AGAIN");
  assert.equal(d.retriesUsed, 0);
  assert.match(d.reason, /retry 1\/2/);
});

test("FAILED + 未達重試上限 → RESEARCH_AGAIN", () => {
  const d = validateEvidenceGate(
    { stage1: "FAILED", summary: summary(), risk: "low", researchRetries: 0 },
    engine,
  );
  assert.equal(d.status, "RESEARCH_AGAIN");
  assert.match(d.reason, /retry 1\/2/);
});

test("重試耗盡後 PARTIAL + 低風險 + 本地證據足夠 → DEGRADED（帶旗標）", () => {
  const d = validateEvidenceGate(
    { stage1: "PARTIAL", summary: summary(), risk: "low", researchRetries: 2 },
    engine,
  );
  assert.equal(d.status, "DEGRADED");
  assert.equal(d.retriesUsed, 2);
  assert.ok(d.degraded, "應帶降級旗標");
  assert.equal(d.degraded!.scope, "implementation");
  assert.equal(d.degraded!.originalDecision, "PASS");
  assert.equal(d.degraded!.actor, "policy");
  assert.match(d.degraded!.reason, /research_partial/);
});

test("重試耗盡後 high risk PARTIAL → BLOCK（高風險不得降級，§14.2 鐵律）", () => {
  const d = validateEvidenceGate(
    { stage1: "PARTIAL", summary: summary(), risk: "high", researchRetries: 2 },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.equal(d.blocks, 1);
  assert.match(d.reason, /high_risk/);
  assert.ok(!d.degraded, "高風險不允許降級");
});

test("FAILED + 重試耗盡 → on_failed=ask_user → BLOCK（不擅自降級）", () => {
  // default.yaml research_failure.on_failed = ask_user
  const d = validateEvidenceGate(
    { stage1: "FAILED", summary: summary({ facts: 2, sourcesCount: 1 }), risk: "low", researchRetries: 2 },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.match(d.reason, /ask_user/);
  assert.ok(!d.degraded);
});

test("重試耗盡 + PARTIAL + 本地證據不足 → BLOCK（知識缺口）", () => {
  const d = validateEvidenceGate(
    { stage1: "PARTIAL", summary: summary({ facts: 0, sourcesCount: 0 }), risk: "low", researchRetries: 2 },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.match(d.reason, /knowledge|證據/);
});

test("research_failure policy 可由 policy 驅動（max_retries=2, backoff [5,30]）", () => {
  const rf = engine.researchFailurePolicy();
  assert.equal(rf.onPartial, "allow_local");
  assert.equal(rf.onFailed, "ask_user");
  assert.equal(rf.maxRetries, 2);
  assert.deepEqual(rf.retryBackoffSeconds, [5, 30]);
});

test("gate block 計數：BLOCK 一律 blocks=1（供 §36.2 Prevention Rate）", () => {
  const d = validateEvidenceGate(
    { stage1: "COMPLETE", summary: summary({ facts: 1, sourcesCount: 1 }), risk: "medium" },
    engine,
  );
  assert.equal(d.status, "BLOCK");
  assert.equal(d.blocks, 1);
});

test("recordGateBlock 寫入 gate_blocks 表（§36.2 Prevention Rate 資料）", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-gate-"));
  const db = createDb(dir);
  const tm = new TaskManager(db);
  const t = tm.create({ userRequest: "high risk change", risk: "high" });

  tm.recordGateBlock(t.id, "BLOCK", "COMPLETE", "INSUFFICIENT", "knowledge_gap", 0);
  tm.recordGateBlock(t.id, "DEGRADED", "PARTIAL", "SUFFICIENT", "allow_local", 2);

  assert.equal(tm.gateBlockCount(), 1, "只有 BLOCK 計入");
});
