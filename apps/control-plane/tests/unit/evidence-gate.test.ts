// T039 Evidence Gate 單元測試

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvidenceGate, DEFAULT_GATE_THRESHOLDS } from "../../src/evidence/gate-api.js";
import { EVIDENCE_PASS_THRESHOLD } from "../../src/evidence/types.js";
import type { EvidenceSource } from "../../src/evidence/types.js";

function makeEvidence(overrides: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    type: "documentation",
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: "Test Evidence",
    snippet: "test snippet",
    credibility: 0.9,
    relevance: 0.8,
    timeliness: 1.0,
    score: 0.85,
    accessedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("DEFAULT_GATE_THRESHOLDS: 門檻值正確", () => {
  assert.strictEqual(DEFAULT_GATE_THRESHOLDS.passThreshold, EVIDENCE_PASS_THRESHOLD);
  assert.strictEqual(DEFAULT_GATE_THRESHOLDS.minEvidenceCount, 1);
  assert.strictEqual(DEFAULT_GATE_THRESHOLDS.minSingleScore, 0.3);
});

test("EVIDENCE_PASS_THRESHOLD: 通過門檻為 0.7", () => {
  assert.strictEqual(EVIDENCE_PASS_THRESHOLD, 0.7);
});

test("createEvidenceGate: 返回實例", () => {
  const gate = createEvidenceGate();
  assert.ok(gate instanceof Object);
});

test("evaluate: 空證據列表 → fail（證據數量不足）", () => {
  const gate = createEvidenceGate();
  const result = gate.evaluate({ evidence: [] });
  assert.strictEqual(result.status, "fail");
  assert.ok(result.reasons.some((r) => r.type === "insufficient_evidence_count"));
});

test("evaluate: 單條高分證據 → pass", () => {
  const gate = createEvidenceGate();
  const evidence = [makeEvidence({ score: 0.9, credibility: 1.0, relevance: 0.9, timeliness: 1.0 })];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "pass");
  assert.ok(result.score >= 0.7);
});

test("evaluate: 總分低於 0.7 → fail（insufficient_total_score）", () => {
  const gate = createEvidenceGate();
  const evidence = [makeEvidence({ score: 0.5, credibility: 0.5, relevance: 0.5, timeliness: 0.5 })];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "fail");
  assert.ok(result.reasons.some((r) => r.type === "insufficient_total_score"));
});

test("evaluate: 多條證據加權平均 → pass", () => {
  const gate = createEvidenceGate();
  const evidence = [
    makeEvidence({ type: "code_execution", score: 0.95, credibility: 1.0, relevance: 0.9, timeliness: 1.0 }),
    makeEvidence({ type: "documentation", score: 0.8, credibility: 0.9, relevance: 0.8, timeliness: 1.0 }),
    makeEvidence({ type: "memory", score: 0.85, credibility: 0.8, relevance: 0.85, timeliness: 0.9 }),
  ];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "pass");
  assert.ok(result.score >= 0.7);
});

test("evaluate: 低分證據 → fail（low_single_score）", () => {
  const gate = createEvidenceGate();
  const evidence = [
    makeEvidence({ score: 0.9, credibility: 1.0, relevance: 0.9, timeliness: 1.0 }),
    makeEvidence({ score: 0.2, credibility: 0.3, relevance: 0.3, timeliness: 0.3 }), // 低分
  ];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "fail");
  assert.ok(result.reasons.some((r) => r.type === "low_single_score"));
});

test("evaluate: 高風險任務且證據不足 → fail（high_risk_blocked）", () => {
  const gate = createEvidenceGate();
  const evidence = [makeEvidence({ score: 0.75, credibility: 0.8, relevance: 0.8, timeliness: 0.8 })];
  const result = gate.evaluate({ evidence, risk: "high" });
  assert.strictEqual(result.status, "fail");
  assert.ok(result.reasons.some((r) => r.type === "high_risk_blocked"));
});

test("evaluate: 高風險任務且充分證據 → pass", () => {
  const gate = createEvidenceGate();
  const evidence = [
    makeEvidence({ score: 0.9, credibility: 1.0, relevance: 0.9, timeliness: 1.0 }),
    makeEvidence({ score: 0.85, credibility: 0.9, relevance: 0.9, timeliness: 1.0 }),
  ];
  const result = gate.evaluate({ evidence, risk: "high" });
  assert.strictEqual(result.status, "pass");
});

test("evaluate: 自定義權重影響分數", () => {
  const gate = createEvidenceGate({ weights: { code_execution: 2.0, documentation: 0.5 } });
  const evidence = [
    makeEvidence({ type: "code_execution", score: 0.6, credibility: 0.7, relevance: 0.6, timeliness: 0.7 }),
    makeEvidence({ type: "documentation", score: 0.9, credibility: 0.9, relevance: 0.9, timeliness: 1.0 }),
  ];
  const result = gate.evaluate({ evidence });
  // code_execution 權重較高，應拉高總分
  assert.ok(result.score > 0.6);
});

test("evaluate: 自定義門檻生效", () => {
  const gate = createEvidenceGate({ thresholds: { passThreshold: 0.5 } });
  const evidence = [makeEvidence({ score: 0.55, credibility: 0.6, relevance: 0.6, timeliness: 0.6 })];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "pass");
});

test("evaluate: 結果包含完整統計資訊", () => {
  const gate = createEvidenceGate();
  const evidence = [
    makeEvidence({ type: "code_execution", score: 0.9 }),
    makeEvidence({ type: "documentation", score: 0.8 }),
  ];
  const result = gate.evaluate({ evidence });
  assert.ok(result.stats.totalEvidence === 2);
  assert.ok(result.stats.passedEvidence >= 0);
  assert.ok(typeof result.stats.avgScore === "number");
  assert.ok(result.stats.byType.code_execution);
  assert.ok(result.stats.byType.documentation);
  assert.ok(result.timestamp);
});

test("evaluate: 失敗原因包含詳細資訊", () => {
  const gate = createEvidenceGate();
  const evidence = [makeEvidence({ score: 0.5 })];
  const result = gate.evaluate({ evidence });
  const reason = result.reasons.find((r) => r.type === "insufficient_total_score");
  assert.ok(reason);
  assert.ok(reason.details);
  assert.ok(typeof reason.details?.score === "number");
  assert.ok(typeof reason.details?.threshold === "number");
});

test("evaluate: 低風險單條低分證據 → fail（low_single_score）", () => {
  const gate = createEvidenceGate();
  const evidence = [makeEvidence({ score: 0.25, credibility: 0.3, relevance: 0.3, timeliness: 0.3 })];
  const result = gate.evaluate({ evidence });
  assert.strictEqual(result.status, "fail");
  assert.ok(result.reasons.some((r) => r.type === "low_single_score"));
});