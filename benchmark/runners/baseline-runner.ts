/**
 * T030 Baseline Runner — Baseline Groups A–F 完整跑分。
 *
 * 用法：
 *   npx tsx benchmark/runners/baseline-runner.ts --baseline A|B|C|D|E|F|all
 *                          [--language python] [--max-tasks N] [--mode llama|stub] [--keep]
 *
 * Baseline 設定矩陣：
 * | Group | Policy | Research | Verification | 說明 |
 * |-------|--------|----------|--------------|------|
 * | A     | ❌     | ❌       | ❌           | Raw 9B |
 * | B     | ❌     | ✅       | ❌           | Research Only |
 * | C     | ✅     | ❌       | ❌           | Policy Only |
 * | D     | ❌     | ❌       | ✅           | Verification Only |
 * | E     | ❌     | ✅       | ✅           | Research + Verification |
 * | F     | ✅     | ✅       | ✅           | Full CP (已驗證) |
 */

import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "../../apps/control-plane/src/db/index.js";
import { TaskManager } from "../../apps/control-plane/src/task/task-manager.js";
import { createTaskBus } from "../../apps/control-plane/src/events/bus.js";
import { loadPolicies } from "../../apps/control-plane/src/policy/loader.js";
import { PolicyEngine } from "../../apps/control-plane/src/policy/engine.js";
import { createRunner } from "../../apps/control-plane/src/runner.js";
import { WorkerRegistry } from "../../apps/control-plane/src/worker/registry.js";
import { PiWorker } from "../../apps/control-plane/src/worker/pi-worker.js";
import { createArtifactController, validatePatch, diffFiles } from "../../apps/control-plane/src/artifact/controller.js";
import { VerificationEngine } from "../../apps/control-plane/src/verification/engine.js";
import { createDefaultRegistry } from "../../apps/control-plane/src/sandbox/registry.js";
import { buildVerificationContext } from "../../apps/control-plane/src/verification/context.js";
import { UnitTestVerifier, LintVerifier } from "../../apps/control-plane/src/verification/verifiers.js";
import type { WorkerResult } from "../../apps/control-plane/src/worker/types.js";
import { createStyleKbRetriever } from "../../apps/control-plane/src/rag/style-kb.js";
import { DatabaseSync as StyleKbDb } from "node:sqlite";
import { StyleKnowledgeBase } from "../../apps/control-plane/src/rag/style-kb.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICIES_DIR = join(REPO_ROOT, "policies");
const TASKS_JSON = join(REPO_ROOT, "benchmark/tasks/tasks.json");
const DATASETS_ROOT = join(REPO_ROOT, "benchmark/datasets");
const STYLE_KB_PATH = join(REPO_ROOT, "apps/control-plane/.style-kb.db");

interface BaselineConfig {
  name: string;
  policyEnabled: boolean;
  researchEnabled: boolean;
  verificationEnabled: boolean;
}

const BASELINES: Record<string, BaselineConfig> = {
  A: { name: "Raw 9B", policyEnabled: false, researchEnabled: false, verificationEnabled: false },
  B: { name: "Research Only", policyEnabled: false, researchEnabled: true, verificationEnabled: false },
  C: { name: "Policy Only", policyEnabled: true, researchEnabled: false, verificationEnabled: false },
  D: { name: "Verification Only", policyEnabled: false, researchEnabled: false, verificationEnabled: true },
  E: { name: "Research + Verification", policyEnabled: false, researchEnabled: true, verificationEnabled: true },
  F: { name: "Full CP", policyEnabled: true, researchEnabled: true, verificationEnabled: true },
};

interface TaskSpec {
  id: string;
  language: string;
  level: string;
  lib: string;
  request: string;
  research_facts: string;
  official_doc: string;
}

interface TasksData {
  count: number;
  tasks: TaskSpec[];
}

interface BaselineResult {
  baseline: string;
  taskId: string;
  success: boolean;
  attempts: number;
  evidenceCount: number;
  finalStatus: string;
  workerOk: boolean;
  patchFiles: string[];
  verification: Array<{ verifier: string; status: string }>;
  durationMs: number;
  error?: string;
}

/** 從 sample dataset 複製出可寫 workspace（每次 run 獨立） */
function prepareWorkspace(datasetDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-baseline-"));
  cpSync(datasetDir, dir, { recursive: true });
  return dir;
}

/** 依 lib 名稱對應到 dataset 目錄名 */
function libToDatasetDir(lib: string): string {
  const map: Record<string, string> = {
    requests: "py-requests",
    httpx: "py-httpx",
    yaml: "py-yaml",
    "beautifulsoup4": "py-bs4",
    rich: "py-rich",
    click: "py-click",
    pandas: "py-pandas",
    sqlalchemy: "py-sqlalchemy",
    fastapi: "py-fastapi",
    redis: "py-redis",
  };
  return map[lib] ?? `py-${lib}`;
}

/** 載入 tasks.json */
function loadTasks(): TaskSpec[] {
  const data = JSON.parse(readFileSync(TASKS_JSON, "utf8")) as TasksData;
  return data.tasks.filter((t) => t.language === "Python");
}

/** 為 task 產生 research evidence（依 lib 客製化） */
function buildEvidenceForTask(task: TaskSpec): Array<{ claim: string; source: string; sourceType: string; confidence: number }> {
  const lib = task.lib;
  const base = task.research_facts;
  if (lib === "requests") {
    return [
      { claim: "requests.get(url) 回傳 Response 物件；HTTP 狀態碼在 response.status_code 屬性（int）。", source: "requests-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "requests library 需先 `import requests`；get() 需傳完整 URL 字串，可用 timeout 參數。", source: "requests-quickstart", sourceType: "official_documentation", confidence: 0.85 },
      { claim: "repo 測試慣例：tests/test_api_client.py 使用 monkeypatch 替換 requests.get（現有 FakeResponse fixture，驗證 sandbox 無網路）——新增測試應沿用此慣例。", source: "pytest-monkeypatch", sourceType: "official_documentation", confidence: 0.7 },
    ];
  }
  if (lib === "httpx") {
    return [
      { claim: "httpx.get(url) 回傳 Response 物件；狀態碼在 response.status_code。", source: "httpx-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "httpx 需 `import httpx`；支援 async/await；可用 timeout。", source: "httpx-quickstart", sourceType: "official_documentation", confidence: 0.85 },
      { claim: "測試用 monkeypatch 替換 httpx.get，回傳 mock response。", source: "pytest-monkeypatch", sourceType: "official_documentation", confidence: 0.7 },
    ];
  }
  if (lib === "yaml" || lib === "pyyaml") {
    return [
      { claim: "yaml.safe_load(text) 解析 YAML 字串回傳 dict。", source: "pyyaml-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "需 `import yaml`；safe_load 安全、不執行任意代碼。", source: "pyyaml-docs", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "beautifulsoup4" || lib === "bs4") {
    return [
      { claim: "BeautifulSoup(html, 'html.parser') 解析 HTML；.title.string 取得標題。", source: "bs4-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "需 `from bs4 import BeautifulSoup`。", source: "bs4-docs", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "rich") {
    return [
      { claim: "Console(record=True, width=80).print(text) → export_text() 捕獲輸出。", source: "rich-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "需 `from rich.console import Console`。", source: "rich-docs", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "click") {
    return [
      { claim: "@click.command() + @click.argument() 定義 CLI；click.echo 輸出。", source: "click-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "測試用 CliRunner().invoke(cmd, args)。", source: "click-testing", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "pandas") {
    return [
      { claim: "pd.DataFrame(rows) 建立表格；len(df) 取得列數。", source: "pandas-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "需 `import pandas as pd`。", source: "pandas-docs", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "sqlalchemy") {
    return [
      { claim: "Session.add(obj); session.commit(); select(Model).where(...) 查詢。", source: "sqlalchemy-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "需 `from sqlalchemy.orm import Session` + declarative_base 模型。", source: "sqlalchemy-docs", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "fastapi") {
    return [
      { claim: "FastAPI() + @app.get('/health') 定義端點；回傳 dict 自動轉 JSON。", source: "fastapi-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "測試用 TestClient(app)。", source: "fastapi-testing", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  if (lib === "redis" || lib === "redis-py") {
    return [
      { claim: "redis.Redis() 連線；client.set(key, val); client.get(key) 取得 bytes。", source: "redis-py-official", sourceType: "official_documentation", confidence: 0.9 },
      { claim: "測試可用 unittest.mock.Mock 模擬 client。", source: "redis-py-testing", sourceType: "official_documentation", confidence: 0.85 },
    ];
  }
  // 通用 fallback
  return [
    { claim: `${base} - 需研究 ${lib} 官方 API。`, source: `${lib}-official`, sourceType: "official_documentation", confidence: 0.7 },
  ];
}

/** 主執行函式 */
async function main() {
  const argv = process.argv.slice(2);
  const baselineArg = argv.find((a) => a.startsWith("--baseline"))?.split("=")[1] ?? argv[argv.indexOf("--baseline") + 1] ?? "all";
  const maxTasksArg = argv.find((a) => a.startsWith("--max-tasks"))?.split("=")[1] ?? argv[argv.indexOf("--max-tasks") + 1];
  const maxTasks = maxTasksArg ? parseInt(maxTasksArg, 10) : undefined;
  const tasksArg = argv.find((a) => a.startsWith("--tasks"))?.split("=")[1];
  const tasksIdx = argv.indexOf("--tasks");
  const tasksNext = tasksIdx !== -1 ? argv[tasksIdx + 1] : undefined;
  const tasksValue = tasksArg ?? tasksNext;
  const taskFilter = tasksValue ? tasksValue.split(/[\s,]+/) : undefined;
  const modeArg = argv.find((a) => a.startsWith("--mode"))?.split("=")[1] ?? argv[argv.indexOf("--mode") + 1] ?? "llama";
  const useLlama = modeArg !== "stub";
  const keep = argv.includes("--keep");

  const selected = baselineArg === "all" ? Object.keys(BASELINES) : [baselineArg];
  if (selected.some((b) => !BASELINES[b])) {
    console.error(`未知 baseline: ${baselineArg}。可用: ${Object.keys(BASELINES).join(", ")}`);
    process.exit(1);
  }

  const allTasks = loadTasks();
  let tasksToRun = allTasks;
  if (taskFilter) {
    tasksToRun = allTasks.filter((t) => taskFilter.includes(t.id));
  } else if (maxTasks) {
    tasksToRun = allTasks.slice(0, maxTasks);
  }
  console.log(`=== T030 Baseline Runner ===`);
  console.log(`Baselines: ${selected.join(", ")}`);
  console.log(`Tasks: ${tasksToRun.map((t) => t.id).join(", ")}`);
  console.log(`Mode: ${useLlama ? "llama (real)" : "stub"}`);
  console.log(`Keep failures: ${keep}\n`);

  // 載入 style KB for RAG retriever (if file exists)
  let styleKb: StyleKnowledgeBase | null = null;
  try {
    const kbDb = new StyleKbDb(STYLE_KB_PATH);
    styleKb = new StyleKnowledgeBase(kbDb);
    console.log(`[RAG] Style KB loaded: ${styleKb.count()} cases`);
  } catch {
    console.log("[RAG] Style KB not found, running without RAG retriever");
  }
  const ragRetriever = styleKb ? createStyleKbRetriever(styleKb, { language: () => "python" }) : undefined;

  const allResults: BaselineResult[] = [];
  const keptDirs: string[] = [];

  for (const blKey of selected) {
    const config = BASELINES[blKey];
    console.log(`\n========== Baseline ${blKey} (${config.name}) ==========`);

    for (let ti = 0; ti < tasksToRun.length; ti++) {
      const task = tasksToRun[ti];
      console.log(`\n[${blKey}] ${task.id} (${task.lib}) ${ti + 1}/${tasksToRun.length}`);

      const datasetDir = join(DATASETS_ROOT, libToDatasetDir(task.lib));
      if (!existsSync(datasetDir)) {
        console.error(`  Dataset not found: ${datasetDir}`);
        allResults.push({
          baseline: blKey,
          taskId: task.id,
          success: false,
          attempts: 0,
          evidenceCount: 0,
          finalStatus: "DATASET_MISSING",
          workerOk: false,
          patchFiles: [],
          verification: [],
          durationMs: 0,
          error: `Dataset not found: ${datasetDir}`,
        });
        continue;
      }

      const ws = prepareWorkspace(datasetDir);
      const startMs = Date.now();

      try {
        // DB + TaskManager
        const db = createDb(join(ws, ".acp-e2e-data"));
        const tm = new TaskManager(db);
        const bus = createTaskBus();
        const policies = loadPolicies(POLICIES_DIR);
        const engine = new PolicyEngine(policies, { enabled: config.policyEnabled });

        // Worker (with RAG retriever)
        const worker = new PiWorker({
          allowStub: !useLlama,
          pingTimeoutMs: 3_000,
          llamaTimeoutMs: 600_000,
          llamaMaxTokens: 800,
          ragRetriever,
        });
        const registry = new WorkerRegistry();
        registry.register(
          { id: "pi-local", runtime: "pi", capabilities: ["coding", "testing"], models: ["robit/ornith:9b"], locality: "local", costClass: "free", supportsACP: true, supportsMCP: true, enabled: true },
          worker,
        );

        const runner = createRunner(tm, bus, engine, { workerRegistry: registry });
        const sandboxRegistry = createDefaultRegistry({ seatbeltProfile: join(REPO_ROOT, "sandbox-profiles/verification-default.sb") });
        const verification = new VerificationEngine({
          registry: sandboxRegistry,
          policy: { sandbox: { mode: "seatbelt" }, securityLevel: "low" },
          record: () => {},
        });
        const controller = createArtifactController({ db });

        // Create task
        const t = tm.create({
          userRequest: task.request,
          risk: config.researchEnabled ? "medium" : "low",
          sandboxMode: "seatbelt",
          workspace: ws,
        });

        // Evidence injection (if research enabled)
        if (config.researchEnabled) {
          const evidence = buildEvidenceForTask(task);
          const facts = evidence.map((e) => ({
            claim: e.claim,
            sourceUri: e.source,
            sourceType: e.sourceType,
            confidence: e.confidence,
          }));
          tm.recordEvidence(t.id, facts);
          // Drive research COMPLETE
          try {
            runner.reportResearch(t.id, { facts: evidence.length, sourcesCount: 1, officialSources: 1 }, "COMPLETE");
          } catch (e) {
            console.error(`[ERROR] reportResearch failed:`, e);
            throw e;
          }
        }

        // Wait for worker to produce patch
        await new Promise<void>((resolve) => {
          const check = () => {
            const row = tm.getRow(t.id);
            if (!row) return resolve();
            if (row.status === "ARTIFACT_VALIDATION" || row.status === "VERIFYING" || row.status === "COMPLETE" || row.status === "ASK_USER" || row.status === "STOP" || row.status === "FAILED") {
              return resolve();
            }
            setTimeout(check, 500);
          };
          runner.start(t.id);
          check();
        });

        const row = tm.getRow(t.id);
        if (!row) throw new Error("task row missing");

        // If ASK_USER (policy blocked) → record result
        if (row.status === "ASK_USER") {
          allResults.push({
            baseline: blKey,
            taskId: task.id,
            success: false,
            attempts: row.attempt,
            evidenceCount: config.researchEnabled ? 3 : 0,
            finalStatus: "ASK_USER",
            workerOk: false,
            patchFiles: [],
            verification: [],
            durationMs: Date.now() - startMs,
          });
          if (keep) keptDirs.push(keepResult(blKey, task.id, ws));
          continue;
        }

        // If STOP/FAILED without patch
        if (!["ARTIFACT_VALIDATION", "VERIFYING", "COMPLETE"].includes(row.status)) {
          allResults.push({
            baseline: blKey,
            taskId: task.id,
            success: false,
            attempts: row.attempt,
            evidenceCount: config.researchEnabled ? 3 : 0,
            finalStatus: row.status,
            workerOk: false,
            patchFiles: [],
            verification: [],
            durationMs: Date.now() - startMs,
            error: `Worker did not produce patch (status=${row.status})`,
          });
          if (keep) keptDirs.push(keepResult(blKey, task.id, ws));
          continue;
        }

        // Artifact gate + verification loop
        let finalVerification: Array<{ verifier: string; status: string }> = [];
        let finalSuccess = false;
        let finalStatus = "ARTIFACT_VALIDATION";
        let finalPatchFiles: string[] = [];
        let finalAttempts = row.attempt;
        const maxAttempts = engine.retryMaxAttempts();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          // Wait for patch
          const patches = db.prepare("SELECT diff FROM patches WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").all(t.id) as Array<{ diff: string }>;
          if (patches.length === 0) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const patch = patches[0].diff;
          const canonical = await controller.canonicalizeDiff(patch, ws);
          if (!canonical.trim()) continue;

          // Artifact gate
          const artifactPolicy = {
            allowed: ["src/**", "tests/**", "*.toml", "*.yaml", "*.yml", "*.json", "*.cfg", "*.ini"],
            readonly: ["tests/test_*.py", "package-lock.json", "go.mod", "go.sum"],
            forbidden: [".git/**", ".env", "secrets/**"],
          };
          let gateOk = true;
          try {
            validatePatch({ diff: canonical }, artifactPolicy as never);
          } catch {
            gateOk = false;
          }
          if (!gateOk) {
            runner.reportVerificationFailure(t.id, "Artifact Gate 拒絕");
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }

          // Apply
          try {
            await controller.apply({ taskId: t.id, attempt, diff: canonical, workspaceDir: ws }, artifactPolicy as never);
          } catch (e) {
            runner.reportVerificationFailure(t.id, `Apply failed: ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          finalPatchFiles = diffFiles(canonical);

          // Verification
          if (config.verificationEnabled) {
            const ctx = buildVerificationContext(ws);
            const vctx = { taskId: t.id, attempt, workspaceDir: ws, repo: ctx, task: { risk: "low" as const, sandboxMode: "seatbelt" } };
            const { results } = await verification.verify(vctx, [UnitTestVerifier, LintVerifier]);
            finalVerification = results.map((r) => ({ verifier: r.verifier, status: r.status }));
            const unitPass = results.some((r) => r.verifier === "unit_test" && r.status === "PASS");
            if (unitPass) {
              finalSuccess = true;
              finalStatus = "COMPLETE";
              break;
            }
            // Failure → feedback retry
            const fail = results.find((r) => r.status !== "PASS");
            runner.reportVerificationFailure(t.id, fail?.output ?? "(no output)");
            await new Promise((r) => setTimeout(r, 500));
          } else {
            // Verification disabled → auto COMPLETE
            finalSuccess = true;
            finalStatus = "COMPLETE";
            break;
          }
        }

        allResults.push({
          baseline: blKey,
          taskId: task.id,
          success: finalSuccess,
          attempts: finalAttempts,
          evidenceCount: config.researchEnabled ? 3 : 0,
          finalStatus,
          workerOk: true,
          patchFiles: finalPatchFiles,
          verification: finalVerification,
          durationMs: Date.now() - startMs,
        });

        if (keep && !finalSuccess) keptDirs.push(keepResult(blKey, task.id, ws));
        console.log(`  ${finalSuccess ? "✅" : "❌"} ${task.id}: ${finalStatus} (attempts=${finalAttempts})`);
      } catch (e) {
        allResults.push({
          baseline: blKey,
          taskId: task.id,
          success: false,
          attempts: 0,
          evidenceCount: 0,
          finalStatus: "ERROR",
          workerOk: false,
          patchFiles: [],
          verification: [],
          durationMs: Date.now() - startMs,
          error: (e as Error).message,
        });
        console.error(`  ❌ ${task.id}: ${(e as Error).message}`);
      }
    }
  }

  // Summary
  console.log("\n========== SUMMARY ==========");
  for (const blKey of selected) {
    const res = allResults.filter((r) => r.baseline === blKey);
    const ok = res.filter((r) => r.success).length;
    const total = res.length;
    console.log(`${blKey} (${BASELINES[blKey].name}): ${ok}/${total} success`);
  }

  // Save results
  const outDir = join(REPO_ROOT, "results-keep", "t030_baseline_abef");
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(outDir, `results_${timestamp}.json`), JSON.stringify({ baselines: allResults, timestamp }, null, 2));
  console.log(`\nResults saved to ${outDir}/results_${timestamp}.json`);
  if (keptDirs.length > 0) console.log("Kept workspaces:", keptDirs);
}

// 保留失敗 workspace（§36.4）
function keepResult(baseline: string, taskId: string, ws: string): string {
  const dir = join(REPO_ROOT, "results-keep", "t030_baseline_abef", `${baseline}_${taskId}_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  cpSync(ws, join(dir, "workspace"), { recursive: true });
  return dir;
}

main().catch((e) => { console.error(e); process.exit(1); });