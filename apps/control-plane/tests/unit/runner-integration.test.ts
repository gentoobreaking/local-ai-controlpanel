// Runner 整合測試（T019/T020 接入）：Evidence Gate 四分支 + Reflection 動作。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../../src/db/index.js";
import { TaskManager } from "../../src/task/task-manager.js";
import { createTaskBus } from "../../src/events/bus.js";
import { loadPolicies } from "../../src/policy/loader.js";
import { PolicyEngine } from "../../src/policy/engine.js";
import { createRunner, type TaskRunner } from "../../src/runner.js";
import { WorkerRegistry } from "../../src/worker/registry.js";
import { PiWorker } from "../../src/worker/pi-worker.js";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "acp-runner-"));
  const db = createDb(dir);
  const tm = new TaskManager(db);
  const bus = createTaskBus();
  const events: string[] = [];
  const engine = new PolicyEngine(loadPolicies(policiesDir));
  const runner = createRunner(tm, bus, engine);
  const task = tm.create({ userRequest: "implement feature X" });
  return { tm, bus, events, runner, task };
}

test("start：policy 要求研究 → RESEARCH_REQUIRED → RESEARCHING", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  assert.equal(tm.getRow(task.id)!.status, "RESEARCHING");
});

test("T021：有 registry 時 IMPLEMENTING → PiWorker stub → ARTIFACT_VALIDATION（Task→Worker→Patch 閉環）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-runner-w-"));
  const db = createDb(dir);
  const tm = new TaskManager(db);
  const bus = createTaskBus();
  const engine = new PolicyEngine(loadPolicies(policiesDir));
  const registry = new WorkerRegistry();
  // 短 ping 超時 + 指向必定不可達的 port：無論本機 llama.cpp 是否在跑，都強制走 stub 路徑
  // （集成測試不可依賴外部 llama-server 狀態）
  const worker = new PiWorker({ pingTimeoutMs: 200 });
  await worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "test-model", workspaceRoot: "/tmp" });
  registry.register(
    {
      id: "pi-local",
      runtime: "pi",
      capabilities: ["coding", "testing"],
      models: ["qwen2.5-coder:7b"],
      locality: "local",
      costClass: "free",
      supportsACP: true,
      supportsMCP: true,
      enabled: true,
    },
    worker,
  );
  const runner = createRunner(tm, bus, engine, { workerRegistry: registry });
  const task = tm.create({ userRequest: "implement feature X" });
  runner.start(task.id);
  assert.equal(tm.getRow(task.id)!.status, "RESEARCHING");
  // 研究完成 → gate PASS → PLANNING → WORKER_SELECTION → IMPLEMENTING → worker stub 產出 patch
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "COMPLETE");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tm.getRow(task.id)!.status, "ARTIFACT_VALIDATION");
});

test("reportResearch PASS → EVIDENCE_VALIDATION → PLANNING → IMPLEMENTING", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "COMPLETE");
  assert.equal(tm.getRow(task.id)!.status, "IMPLEMENTING");
});

test("reportResearch 證據不足 → BLOCK → ASK_USER（知識缺口硬性）", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 1, sourcesCount: 1, officialSources: 0 }, "COMPLETE");
  assert.equal(tm.getRow(task.id)!.status, "ASK_USER");
  assert.equal(tm.gateBlockCount(), 1);
});

test("approve：ASK_USER → PLANNING", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 1, sourcesCount: 1, officialSources: 0 }, "COMPLETE");
  assert.equal(tm.getRow(task.id)!.status, "ASK_USER");
  runner.approve(task.id);
  assert.equal(tm.getRow(task.id)!.status, "PLANNING");
});

test("PARTIAL 未達重試上限 → RESEARCH_AGAIN（回到 RESEARCHING）", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 1, sourcesCount: 0, officialSources: 0 }, "PARTIAL");
  assert.equal(tm.getRow(task.id)!.status, "RESEARCHING");
  // 第二次 PARTIAL → 仍 RESEARCHING（retry 2/2）
  runner.reportResearch(task.id, { facts: 1, sourcesCount: 0, officialSources: 0 }, "PARTIAL");
  assert.equal(tm.getRow(task.id)!.status, "RESEARCHING");
});

test("重試耗盡 + 低風險 + 本地證據足夠 → DEGRADED → IMPLEMENTING（帶旗標）", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  // 第 3 次回報（retries=2 已耗盡）；sourcesCount=2 → Stage 2 SUFFICIENT
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "PARTIAL");
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "PARTIAL");
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "PARTIAL");
  assert.equal(tm.getRow(task.id)!.status, "IMPLEMENTING");
  assert.ok(tm.getRow(task.id)!.flags.some((f) => f.startsWith("degraded:")));
});

test("重試耗盡 + 無本地證據 → BLOCK（知識缺口）", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 0, sourcesCount: 0, officialSources: 0 }, "FAILED");
  runner.reportResearch(task.id, { facts: 0, sourcesCount: 0, officialSources: 0 }, "FAILED");
  runner.reportResearch(task.id, { facts: 0, sourcesCount: 0, officialSources: 0 }, "FAILED");
  assert.equal(tm.getRow(task.id)!.status, "ASK_USER"); // on_failed=ask_user → BLOCK → ASK_USER
  assert.equal(tm.gateBlockCount(), 1);
});

test("verification 失敗 → REFLECTION：environment_error → repair → ARTIFACT_VALIDATION", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "COMPLETE");
  assert.equal(tm.getRow(task.id)!.status, "IMPLEMENTING");
  // 模擬走到 VERIFYING（直接 update 狀態）
  tm.updateStatus(task.id, "VERIFYING");
  runner.reportVerificationFailure(task.id, "bash: pytest: command not found");
  assert.equal(tm.getRow(task.id)!.status, "ARTIFACT_VALIDATION");
  const refl = tm.lastReflection(task.id);
  assert.equal(refl!.classification, "environment_error");
  assert.equal(refl!.recommendedAction, "repair_environment");
});

test("verification 失敗 → REFLECTION：model_limitation → STOP（§24 Phase 1–5）", () => {
  const { tm, runner, task } = setup();
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "COMPLETE");
  tm.updateStatus(task.id, "VERIFYING");
  runner.reportVerificationFailure(task.id, "output truncated: max tokens reached");
  assert.equal(tm.getRow(task.id)!.status, "STOP");
});

test("reflection 事件發出（§45.5 SSE schema）", () => {
  const { tm, bus, runner, task } = setup();
  const reflections: string[] = [];
  bus.on(task.id, (e) => {
    if (e.type === "reflection") reflections.push(e.classification ?? "");
  });
  runner.start(task.id);
  runner.reportResearch(task.id, { facts: 3, sourcesCount: 2, officialSources: 1 }, "COMPLETE");
  tm.updateStatus(task.id, "VERIFYING");
  runner.reportVerificationFailure(task.id, "ModuleNotFoundError: No module named 'x'");
  assert.ok(reflections.includes("knowledge_error"));
});
