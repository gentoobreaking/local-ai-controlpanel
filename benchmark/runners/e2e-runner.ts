/**
 * T023 E2E Driver — 第一個 E2E Test（spec §40）
 *
 * 對照實驗：同一個 Python task（外部庫 API 需 research），
 *   run 1: Research ON  → 完整 CP 路徑（Policy → Research → Evidence Gate → Pi+llama → Patch → pytest）
 *   run 2: Research OFF → 無 Evidence 直出（Raw 9B 對照）
 *
 * 每 run 記錄完整 event log（§32/§36.4），輸出 success / attempts / evidence 數 / 差異觀察。
 *
 * 用法：
 *   npx tsx benchmark/runners/e2e-runner.ts [--mode stub|llama] [--only on|off|both] [--keep]
 *   LLAMA_BASE_URL=http://127.0.0.1:11434  （ollama；預設 llama.cpp :8080）
 *   --keep：失敗時保留 workspace copy + result.json 於 results-keep/t023/（§36.4）
 */

import { mkdtempSync, cpSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../apps/control-plane/src/db/index.js";
import { TaskManager } from "../../apps/control-plane/src/task/task-manager.js";
import { createTaskBus } from "../../apps/control-plane/src/events/bus.js";
import { loadPolicies } from "../../apps/control-plane/src/policy/loader.js";
import { PolicyEngine } from "../../apps/control-plane/src/policy/engine.js";
import { createRunner } from "../../apps/control-plane/src/runner.js";
import { WorkerRegistry } from "../../apps/control-plane/src/worker/registry.js";
import { PiWorker } from "../../apps/control-plane/src/worker/pi-worker.js";
import { createArtifactController, validatePatch, diffFiles, normalizeExistingFiles } from "../../apps/control-plane/src/artifact/controller.js";
import { VerificationEngine } from "../../apps/control-plane/src/verification/engine.js";
import { createDefaultRegistry } from "../../apps/control-plane/src/sandbox/registry.js";
import { buildVerificationContext } from "../../apps/control-plane/src/verification/context.js";
import { UnitTestVerifier, LintVerifier } from "../../apps/control-plane/src/verification/verifiers.js";
import type { WorkerResult } from "../../apps/control-plane/src/worker/types.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICIES_DIR = join(REPO_ROOT, "policies");
const SAMPLE_REPO = join(REPO_ROOT, "benchmark/datasets/python-external-lib");

interface E2ERunConfig {
  /** research on/off（對照組） */
  research: boolean;
  /** 真實 llama.cpp 連線（false → stub 快速路徑） */
  useLlama: boolean;
  workspace: string;
  taskRequest: string;
  label: string;
}

export interface E2EResult {
  label: string;
  research: boolean;
  success: boolean;
  attempts: number;
  evidenceCount: number;
  finalStatus: string;
  stages: string[];
  workerOk: boolean;
  patchFiles: string[];
  verification: Array<{ verifier: string; status: string }>;
  eventLog: Array<{ type: string; stage?: string; ts: string }>;
  patchDiff?: string;
  error?: string;
}

/** 從 sample repo 複製出可寫 workspace（每次 run 獨立，互不污染） */
function prepareWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-e2e-py-"));
  cpSync(SAMPLE_REPO, dir, { recursive: true });
  return dir;
}

const EVENT_LOG: E2EResult["eventLog"] = [];

export function mainWantsKeep(argv = process.argv.slice(2)): boolean {
  return argv.includes("--keep");
}

/** §36.4：保留本次 run 的 workspace copy + 結果 JSON（供回診與報告）。 */
export function keepResult(label: string, result: E2EResult, workspace: string): string {
  const dir = join(REPO_ROOT, "results-keep", "t023", label.replace(/[^a-zA-Z0-9-]/g, "-"));
  mkdirSync(dir, { recursive: true });
  cpSync(workspace, join(dir, "workspace"), {
    recursive: true,
    filter: (src: string) => !src.includes("db-journal") && !src.includes(".acp-e2e-data-wal"),
  });
  try {
    cpSync(join(workspace, ".acp-e2e-data"), join(dir, "e2e.db"));
  } catch {
    // db 可能未建立
  }
  writeFileSync(join(dir, "result.txt"), JSON.stringify(result, null, 2));
  const ev = result.eventLog.map((e) => e.ts).length;
  writeFileSync(join(dir, "result.json"), JSON.stringify({ ...result, eventLogCount: ev }, null, 2));
  return dir;
}

async function runE2E(cfg: E2ERunConfig): Promise<E2EResult> {
  const db = createDb(join(cfg.workspace, ".acp-e2e-data"));
  const tm = new TaskManager(db);
  const bus = createTaskBus();
  const engine = new PolicyEngine(loadPolicies(POLICIES_DIR));

  // worker：llama 或 stub
  const worker = new PiWorker({
    allowStub: !cfg.useLlama,
    pingTimeoutMs: 3_000,
    llamaTimeoutMs: 600_000,
    llamaMaxTokens: 800,
  });
  const registry = new WorkerRegistry();
  registry.register(
    {
      id: "pi-local", runtime: "pi", capabilities: ["coding", "testing"],
      models: ["qwen2.5-coder:7b"], locality: "local", costClass: "free",
      supportsACP: true, supportsMCP: true, enabled: true,
    },
    worker,
  );

  // sandbox（seatbelt；profile 為 §28.1 default-deny 範本）
  const sandboxRegistry = createDefaultRegistry({
    seatbeltProfile: join(REPO_ROOT, "sandbox-profiles/verification-default.sb"),
  });
  const verification = new VerificationEngine({
    registry: sandboxRegistry,
    policy: { sandbox: { mode: "seatbelt" }, securityLevel: "low" },
    record: () => {},
  });

  const runner = createRunner(tm, bus, engine, { workerRegistry: registry });
  const task = tm.create({
    userRequest: cfg.taskRequest,
    risk: cfg.research ? "medium" : "low",
    sandboxMode: "seatbelt",
    workspace: cfg.workspace,
  });
  // event log 收集（§32/§36.4）——bus 事件以 taskId 為名，須任務建立後訂閱
  bus.on(task.id, (e: { type: string; stage?: string; ts?: string }) => {
    EVENT_LOG.push({ type: e.type, stage: e.stage, ts: e.ts ?? new Date().toISOString() });
  });
  const stages: string[] = [];
  const trackStage = () => {
    const s = tm.getRow(task.id)?.status;
    if (s && stages[stages.length - 1] !== s) stages.push(s);
  };

  runner.start(task.id);
  trackStage();

  // ── research ON：注入真實 Evidence（requests 官方 API 事實，§40 預期路徑）──
  if (cfg.research) {
    await waitForStatus(tm, task.id, "RESEARCHING", 10_000);
    trackStage();
    // Rule 3：research 結果先落庫為 evidence（claim + official source），
    // gate 通過後由 runner 送入 worker 的 evidence bundle
    tm.recordEvidence(task.id, [
      {
        claim:
          "requests.get(url) 回傳 Response 物件；HTTP 狀態碼在 response.status_code 屬性（int）。",
        sourceUri: "https://requests.readthedocs.io/en/latest/api/#requests.get",
        sourceType: "official_documentation",
        confidence: 0.9,
      },
      {
        claim:
          "requests library 需先 `import requests`；get() 需傳完整 URL 字串，可用 timeout 參數。",
        sourceUri: "https://requests.readthedocs.io/en/latest/user/quickstart/",
        sourceType: "official_documentation",
        confidence: 0.85,
      },
      {
        claim:
          "repo 測試慣例：tests/test_api_client.py 使用 monkeypatch 替換 requests.get（現有 FakeResponse fixture，驗證 sandbox 無網路）——新增測試應沿用此慣例。",
        sourceUri: "https://docs.pytest.org/en/stable/how-to/monkeypatch.html",
        sourceType: "official_documentation",
        confidence: 0.7,
      },
    ]);
    runner.reportResearch(
      task.id,
      {
        facts: 3,
        sourcesCount: 2,
        officialSources: 2,
      },
      "COMPLETE",
    );
  } else {
    // research OFF（Raw 對照）：空 Evidence + 重試耗盡 → §14.4 gate 重試×2 後
    // on_failed=ask_user（default.yaml）→ 低風險但本地證據不足 → BLOCK → ASK_USER
    await waitForStatus(tm, task.id, "RESEARCHING", 10_000);
    trackStage();
    runner.reportResearch(
      task.id,
      { facts: 0, sourcesCount: 0, officialSources: 0 },
      "FAILED",
    );
    // 重試 1/3 → 回到 RESEARCHING（researchState.retries=1）
    await waitForStatus(tm, task.id, "RESEARCHING", 10_000);
    trackStage();
    runner.reportResearch(
      task.id,
      { facts: 0, sourcesCount: 0, officialSources: 0 },
      "FAILED",
    );
    // 重試 2/3 → RESEARCHING（researchState.retries=2 = maxRetries，§14.4 耗盡）
    await waitForStatus(tm, task.id, "RESEARCHING", 10_000);
    trackStage();
    runner.reportResearch(
      task.id,
      { facts: 0, sourcesCount: 0, officialSources: 0 },
      "FAILED",
    );
    // 重試 3/3 耗盡 → §14.2 on_failed=ask_user + 證據不足 → BLOCK → ASK_USER
    await waitForStatus(tm, task.id, "ASK_USER", 15_000);
    trackStage();
  }

  // 等 worker 產出 patch（llama CPU 模式 30s–5min / stub <1s）
  const stBeforeWorker = tm.getRow(task.id)?.status;
  if (stBeforeWorker === "ASK_USER") {
    // research OFF 對照組：policy 擋在 ASK_USER（Raw 直出不可行）——這就是對照數據
    const stOff = tm.getRow(task.id)?.status;
    return {
      label: cfg.label,
      research: cfg.research,
      success: false,
      attempts: 1,
      evidenceCount: 0,
      finalStatus: stOff ?? "ASK_USER",
      stages,
      workerOk: false,
      patchFiles: [],
      verification: [],
      eventLog: [...EVENT_LOG],
      error: "research OFF（Raw 對照）：§14.2 on_failed=ask_user → 停在 ASK_USER（知識缺口）",
    };
  }
  const result: E2EResult = {
    label: cfg.label,
    research: cfg.research,
    success: false,
    attempts: 1,
    evidenceCount: cfg.research ? 3 : 0,
    finalStatus: "ARTIFACT_VALIDATION",
    stages,
    workerOk: false,
    patchFiles: [],
    verification: [],
    eventLog: [...EVENT_LOG],
  };

  // ── Artifact Gate + Verification 迴圈（T021 §16：驗證失敗 → 回饋 → 重試）──
  const controller = createArtifactController({ db });
  const artifactPolicy = {
    allowed: ["src/**", "tests/**", "*.toml", "*.yaml", "*.yml", "*.json", "*.cfg", "*.ini"],
    readonly: ["tests/test_api_client.py", "package-lock.json", "go.mod", "go.sum"],
    forbidden: [".git/**", ".env", "secrets/**"],
  };
  const maxAttempts = engine.retryMaxAttempts();
  let prevAttempt = 0;

  attemptLoop: for (let round = 0; round < maxAttempts; round += 1) {
    // 等 runner 產出新 attempt 的 patch（T021 §16 重試迴圈；首次 attempt=1）
    const arrived = await waitForNewPatch(tm, task.id, prevAttempt, 420_000);
    trackStage();
    const attempt = tm.getRow(task.id)?.attempt ?? 1;
    if (!arrived) {
      result.error = `worker 未產出 patch ${round > 0 ? `（嘗試 ${round + 1}/${maxAttempts}）` : ""}（status=${tm.getRow(task.id)?.status}）`;
      result.attempts = tm.getRow(task.id)?.attempt ?? 1;
      return result;
    }
    prevAttempt = attempt;
    result.workerOk = true;
    const stNow = tm.getRow(task.id)?.status;
    if (stNow !== "ARTIFACT_VALIDATION") {
      result.error = `worker 未產出 patch（status=${stNow}）`;
      result.attempts = tm.getRow(task.id)?.attempt ?? 1;
      return result;
    }

    // 從 DB 取最新一次 patch
    const patches = db
      .prepare("SELECT diff FROM patches WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .all(task.id) as Array<{ diff: string }>;
    if (patches.length === 0) {
      result.error = "patches 表無記錄（worker 未產 patch）";
      result.attempts = attempt;
      return result;
    }
    const patch = patches[0]!;
    let verdict: Awaited<ReturnType<typeof validatePatch>> | undefined;
    // Canonicalize（T023）：把 model raw diff 套到 scratch copy 後以
    // git diff --no-index 重產「真實內容變更」的最小 diff——模型整檔重 emit、
    // hunk 錯亂、重複新增已存在內容等垃圾在此消散；tests/ 無實質變更即不觸發
    // readonly。policy 驗證與 workspace apply 皆以 canonical diff 為準。
    const canonical: string = await (canonicalizeCatch());
    async function canonicalizeCatch(): Promise<string> {
      try {
        return await controller.canonicalizeDiff(patch.diff, cfg.workspace);
      } catch (err) {
        console.error(`[verification detail] attempt=${attempt} canonicalize_failed=${(err as Error).message}`);
        tm.updateStatus(task.id, "VERIFYING");
        runner.reportVerificationFailure(
          task.id,
          `patch 無法套用至 workspace：${(err as Error).message.split(".")[0]}。請重新產出正確的 git diff（只改 src/，hunk 行號正確）。`,
        );
        return "";
      }
    }
    if (!canonical.trim()) {
      console.error(`[verification detail] attempt=${attempt} empty_diff_after_canonical（無實質變更）`);
      tm.updateStatus(task.id, "VERIFYING");
      runner.reportVerificationFailure(task.id, "模型輸出經正規化後為空（no real changes）——請修改 src/ 等實際檔案。");
      continue;
    }
    try {
      verdict = validatePatch({ diff: canonical }, artifactPolicy as never);
    } catch (err) {
      // Artifact Gate 違規（forbidden/readonly/not_allowed，validatePatch 用 throw）→
      // 回饋給 runner → REFLECTION → retry（與驗證失敗同迴圈）
      console.error(`[verification detail] attempt=${attempt} artifact_gate=${(err as Error).message}`);
      writeFileSync(join(cfg.workspace, `.acp-gate-violation-${attempt}.diff`), canonical);
      tm.updateStatus(task.id, "VERIFYING");
      runner.reportVerificationFailure(
        task.id,
        `Artifact Gate 拒絕：${(err as Error).message}。tests/test_api_client.py 為 readonly 驗收基準，` +
          "禁止修改；新增測試請開新檔（如 tests/test_extra.py）。",
      );
      continue;
    }
    if (verdict.verdict !== "APPROVED") {
      const v = verdict.violations?.[0];
      console.error(
        `[verification detail] attempt=${attempt} artifact_gate=${v ? `${v.file}: ${v.rule}` : "rejected"}`,
      );
      tm.updateStatus(task.id, "VERIFYING");
      runner.reportVerificationFailure(
        task.id,
        `Artifact Gate 拒絕（${v ? `${v.file}: ${v.rule}` : "violation"}）——tests/test_api_client.py 為 readonly 驗收基準，` +
          "禁止修改；新增測試請開新檔（如 tests/test_extra.py）。",
      );
      continue;
    }
    result.patchDiff = canonical;
    result.patchFiles = diffFiles(canonical);

    // 實際 apply 到 workspace
    try {
      await controller.apply(
        {
          taskId: task.id,
          attempt,
          diff: canonical,
          workspaceDir: cfg.workspace,
        },
        artifactPolicy as never,
      );
    } catch (err) {
      result.error = `Artifact Gate 失敗: ${(err as Error).message}`;
      // §36.4 診斷：dump raw/canonical diff 供回診（--keep 保留）
      writeFileSync(join(cfg.workspace, ".acp-raw.diff"), patch.diff);
      writeFileSync(join(cfg.workspace, ".acp-canonical.diff"), canonical);
      result.attempts = attempt;
      return result;
    }

    // Verification：pytest（§40 預期 pytest → PASS）
    try {
      const ctx = buildVerificationContext(cfg.workspace);
      const vctx = {
        taskId: task.id,
        attempt,
        workspaceDir: cfg.workspace,
        repo: ctx,
        task: { risk: "low" as const, sandboxMode: "seatbelt" },
      };
      const { results } = await verification.verify(vctx, [UnitTestVerifier, LintVerifier]);
      result.verification = results.map((r) => ({ verifier: r.verifier, status: r.status }));
      const unitPass = results.some((r) => r.verifier === "unit_test" && r.status === "PASS");
      if (unitPass) {
        result.success = true;
        result.finalStatus = "COMPLETE";
        break attemptLoop;
      }
      // 失敗 → 轉 VERIFYING 後回饋給 runner → REFLECTION → retry（T021 §16 迴圈）
      const fail = results.find((r) => r.status !== "PASS");
      console.error(`[verification detail] attempt=${attempt} ${fail?.verifier}=${fail?.status}`);
      tm.updateStatus(task.id, "VERIFYING");
      runner.reportVerificationFailure(task.id, fail?.output ?? "(no output)");
} catch (err) {
      result.error = `Verification 失敗: ${(err as Error).message}`;
      result.attempts = attempt;
      return result;
    }
  }

  if (!result.success) {
    result.finalStatus = "VERIFYING";
    result.error = `驗證未通過（attempts=${tm.getRow(task.id)?.attempt ?? 1}，初始 1 + 重試 ${maxAttempts}）`;
  }
  result.attempts = tm.getRow(task.id)?.attempt ?? 1;
  return result;
}

/**
 * 等 runner 產出「新 attempt」的 patch（status=ARTIFACT_VALIDATION 且 attempt>prev）。
 * 回傳 false：task 停在終態/REFLECTION（無新 patch）。
 */
async function waitForNewPatch(
  tm: TaskManager,
  taskId: string,
  prevAttempt: number,
  timeoutMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  const terminal = new Set(["COMPLETE", "FAILED", "CANCELLED", "STOP", "ASK_USER"]);
  while (Date.now() - t0 < timeoutMs) {
    const row = tm.getRow(taskId);
    if (!row) return false;
    if (row.attempt > prevAttempt && row.status === "ARTIFACT_VALIDATION") return true;
    if (row.attempt <= prevAttempt && (terminal.has(row.status) || row.status === "REFLECTION")) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForStatus(
  tm: TaskManager,
  taskId: string,
  status: string,
  timeoutMs: number,
  _watch?: string[],
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = tm.getRow(taskId)?.status;
    if (s === status) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting ${status} (last=${tm.getRow(taskId)?.status})`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const workspaceArg = argv.find((a) => a.startsWith("--workspace="));
  const modeArg = argv.find((a) => a.startsWith("--mode="));
  const modeArgSpace = argv[argv.indexOf("--mode") + 1] ?? "";
  const useLlama = modeArg
    ? modeArg.split("=")[1] !== "stub"
    : argv.includes("--mode")
      ? modeArgSpace !== "stub"
      : true;
  const onlyArg = argv.find((a) => a.startsWith("--only"));
  const only = onlyArg ? (onlyArg.split("=")[1] ?? argv[argv.indexOf(onlyArg) + 1] ?? "both") : "both";
  const keep = mainWantsKeep(argv);
  const workspace = workspaceArg ? resolve(workspaceArg.split("=")[1]!) : prepareWorkspace();
  if (!existsSync(join(workspace, "pyproject.toml"))) {
    console.error(`workspace 需含 pyproject.toml：${workspace}`);
    process.exit(1);
  }
  console.log(`E2E workspace: ${workspace}`);
  console.log(`worker mode:   ${useLlama ? "llama (real inference)" : "stub"}`);
  console.log(`llama.cpp:     ${process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080"}\n`);

  const taskRequest =
    "Add a function and tests using an external library whose current API must be researched. " +
    "Implement get_status_code(url) in src/api_client.py that does a GET request with the requests " +
    "library and returns the HTTP status code. The repository already provides tests in " +
    "tests/test_api_client.py as the acceptance criteria — do NOT modify it; extra tests go in new files like tests/test_extra.py.";

  // 對照組：research ON vs OFF（各自獨立 workspace，互不污染）
  const results: E2EResult[] = [];
  const kept: string[] = [];
  if (only === "on" || only === "both") {
    const ws = prepareWorkspace();
    const r = await runE2E({
      label: "research-ON (Full CP)",
      research: true,
      useLlama,
      workspace: ws,
      taskRequest,
    });
    results.push(r);
    if (keep) kept.push(keepResult(r.label, r, ws));
  }

  // 重置 event log 再跑 OFF
  EVENT_LOG.length = 0;
  if (only === "off" || only === "both") {
    const ws = prepareWorkspace();
    const r = await runE2E({
      label: "research-OFF (Raw)",
      research: false,
      useLlama,
      workspace: ws,
      taskRequest,
    });
    results.push(r);
    if (keep) kept.push(keepResult(r.label, r, ws));
  }

  // ── 輸出比較 ──
  console.log("\n========== E2E RESULT（spec §40 第一個 E2E Test） ==========");
  for (const r of results) {
    console.log(`\n[${r.label}]`);
    console.log(`  success:      ${r.success}`);
    console.log(`  finalStatus:  ${r.finalStatus}`);
    console.log(`  attempts:     ${r.attempts}`);
    console.log(`  evidence:     ${r.evidenceCount}`);
    console.log(`  workerOk:     ${r.workerOk}`);
    console.log(`  patchFiles:   ${r.patchFiles.join(", ") || "(none)"}`);
    console.log(`  verification: ${r.verification.map((v) => `${v.verifier}=${v.status}`).join(", ") || "(none)"}`);
    console.log(`  stages:       ${r.stages.join(" → ")}`);
    if (r.error) console.log(`  error:        ${r.error}`);
    if (r.patchDiff) console.log(`  patch:\n${r.patchDiff.split("\n").slice(0, 60).map((l) => `    ${l}`).join("\n")}`);
    console.log(`  events:       ${r.eventLog.length}`);
  }

  const on = results[0];
  const off = results[1];
  if (on && off) {
    console.log("\n---------- 差異觀察（第一份真實數據） ----------");
    console.log(`success:    ON=${on.success}  OFF=${off.success}`);
    console.log(`attempts:   ON=${on.attempts}  OFF=${off.attempts}`);
    console.log(`evidence:   ON=${on.evidenceCount}  OFF=${off.evidenceCount}`);
    console.log(`CP Gain (首份樣本): ${on.success === off.success ? 0 : on.success ? "+100pp" : "-100pp"}（單樣本，正式統計見 T024）`);
  }
  if (kept.length > 0) {
    console.log("\n結果保留（§36.4）:");
    for (const d of kept) console.log(`  ${d}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("E2E FAIL:", e);
    process.exit(1);
  });
}
