// Policy Engine 測試（T010）：載入、evaluateTask/evaluateArtifact/evaluateTool/
// evaluateExecution/evaluateResearch、§24 硬限制、無 LLM（Rule 1）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPolicies } from "../../src/policy/loader.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import type { TaskAnalysis } from "../../src/policy/types.js";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;
const loaded = loadPolicies(policiesDir);
const engine = new PolicyEngine(loaded);

const analysis = (over: Partial<TaskAnalysis> = {}): TaskAnalysis => ({
  languages: ["typescript"],
  frameworks: [],
  dependencies: [],
  complexity: "medium",
  risk: "medium",
  researchRequired: true,
  researchReasons: ["unknown_dependency"],
  ...over,
});

test("載入 policies 全數 valid（含 kubernetes 語法檢查）", () => {
  assert.ok(loaded.defaultPolicy);
  assert.equal(loaded.report.length, 7);
  for (const r of loaded.report) assert.equal(r.valid, true, `${r.name} 應 valid`);
});

test("evaluateTask: unknown_dependency → REQUIRE_RESEARCH", () => {
  const d = engine.evaluateTask(analysis());
  assert.deepEqual(d.action, "REQUIRE_RESEARCH");
  assert.ok((d as { reasons: string[] }).reasons.includes("unknown_dependency"));
});

test("evaluateTask: 無 research reason 且低風險 → ALLOW_PLANNING", () => {
  const d = engine.evaluateTask(
    analysis({ researchReasons: [], risk: "low", researchRequired: false }),
  );
  assert.deepEqual(d, { action: "ALLOW_PLANNING" });
});

test("evaluateTask: 非 required_when 的 reason 不觸發研究", () => {
  const d = engine.evaluateTask(analysis({ researchReasons: ["cosmetic"] }));
  assert.deepEqual(d, { action: "ALLOW_PLANNING" });
});

test("evaluateTask: high risk 一律 REQUIRE_RESEARCH（§10 風險規則）", () => {
  const d = engine.evaluateTask(
    analysis({ researchReasons: [], risk: "high" }),
  );
  assert.deepEqual(d.action, "REQUIRE_RESEARCH");
});

test("evaluateArtifact: allowed 內 → APPROVED", () => {
  // 安全補強後 tests/** 為 readonly——allowed 僅涵蓋產品碼路徑
  const d = engine.evaluateArtifact(["src/main.ts", "lib/util.ts"]);
  assert.deepEqual(d, { verdict: "APPROVED", violations: [] });
});

test("evaluateArtifact: tests/** 為 readonly → DENIED（防改斷言讓測試變綠）", () => {
  const d = engine.evaluateArtifact(["src/main.ts", "tests/foo.test.ts"]);
  assert.equal(d.verdict, "DENIED");
  assert.deepEqual(d.violations, [{ file: "tests/foo.test.ts", rule: "readonly" }]);
});

test("evaluateArtifact: forbidden → DENIED", () => {
  const d = engine.evaluateArtifact(["src/main.ts", ".env"]);
  assert.equal(d.verdict, "DENIED");
  assert.deepEqual(d.violations, [{ file: ".env", rule: "forbidden" }]);
});

test("evaluateArtifact: readonly → DENIED", () => {
  const d = engine.evaluateArtifact(["package-lock.json"]);
  assert.equal(d.verdict, "DENIED");
  assert.deepEqual(d.violations, [{ file: "package-lock.json", rule: "readonly" }]);
});

test("evaluateArtifact: 不在 allowed → DENIED(not_allowed)", () => {
  const d = engine.evaluateArtifact(["node_modules/x/index.js"]);
  assert.equal(d.verdict, "DENIED");
  assert.deepEqual(d.violations, [{ file: "node_modules/x/index.js", rule: "not_allowed" }]);
});

test("evaluateTool: network 預設 DENY（§28）", () => {
  const d = engine.evaluateTool({ tool: "network" });
  assert.equal(d.verdict, "DENY");
});

test("evaluateTool: shell → ALLOW_IN_SANDBOX（§28 Rule 8）", () => {
  const d = engine.evaluateTool({ tool: "shell" });
  assert.equal(d.verdict, "ALLOW_IN_SANDBOX");
});

test("evaluateTool: filesystem read ALLOW / write policy-controlled", () => {
  assert.equal(engine.evaluateTool({ tool: "filesystem_read" }).verdict, "ALLOW");
  assert.equal(engine.evaluateTool({ tool: "filesystem_write" }).verdict, "ALLOW_IN_SANDBOX");
});

test("evaluateExecution: Phase 1–5 強制 local_only + allowCloud false", () => {
  const s = engine.evaluateExecution();
  assert.equal(s.strategy, "local_only");
  assert.equal(s.allowCloud, false);
  assert.equal(s.worker, "pi-local");
  assert.equal(s.maxAttempts, 3);
});

test("evaluateExecution: allow_cloud=true → throw（§24 硬限制，非 prompt）", () => {
  const evil = loadPolicies(policiesDir);
  // 直接改記憶體中的 default 驗證 engine 強制性
  (evil.defaultPolicy as { execution: { allow_cloud: boolean } }).execution.allow_cloud = true;
  const evilEngine = new PolicyEngine(evil);
  assert.throws(() => evilEngine.evaluateExecution(), /allow_cloud/);
});

test("evaluateResearch: 來源不足 → RESEARCH_AGAIN（供 T019）", () => {
  const d = engine.evaluateResearch({ facts: 1, sourcesCount: 1, officialSources: 0 });
  assert.equal(d.decision, "RESEARCH_AGAIN");
  const p = engine.evaluateResearch({ facts: 5, sourcesCount: 3, officialSources: 2 });
  assert.equal(p.decision, "PASS");
});

test("evaluateEscalation: Phase 1–5 一律 NOT_SUPPORTED（型別預留 §25）", () => {
  assert.equal(engine.evaluateEscalation().type, "NOT_SUPPORTED");
});

test("Rule 1：決策過程無任何 LLM 呼叫（engine 內無 fetch/API 呼叫）", () => {
  const src = engine.constructor.toString();
  assert.ok(!src.includes("fetch("), "engine 不得直接 fetch");
  assert.ok(!src.includes("openai"), "engine 不得呼叫 LLM SDK");
});