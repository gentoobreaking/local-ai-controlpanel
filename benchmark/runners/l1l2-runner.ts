// L1/L2 分級題庫跑分 runner（§9 驗證協議）
//
// 用法：
//   npx tsx benchmark/runners/l1l2-runner.ts --mode off|on --runs 3 [--base-url http://127.0.0.1:3002] [--only id1,id2]
//
// 每個 run：
//   1. 重置 fixture workspace（git checkout . && git clean -fdq）
//   2. POST /api/v1/tasks（request + workspace）
//   3. 輪詢至終態（上限 300s）
//   4. 記錄 success / attempts / duration / verification
// 輸出：benchmark/results/l1l2/<mode>-run<k>.json + 總表

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** 背景執行環境 PATH 可能不含 git → 解析絕對路徑 */
const GIT_BIN = existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
import { execFileSync } from "node:child_process";

interface TaskDef {
  id: string;
  level: "L0" | "L1" | "L2";
  workspace: string;
  request: string;
}

interface RunResult {
  taskId: string;      // CP 指派的 ID
  fixtureId: string;   // 題目 ID
  level: string;
  mode: "off" | "on";
  run: number;
  status: string;
  success: boolean;    // COMPLETE 且驗證全 PASS
  attempts: number;
  durationSec: number;
  verifications: Array<{ verifier: string; status: string }>;
}

const args = process.argv.slice(2);
function argOf(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const MODE = (argOf("mode", "off") as "off" | "on");
const RUNS = Number(argOf("runs", "3"));
const BASE_URL = argOf("base-url", "http://127.0.0.1:3002")!;
const ONLY = argOf("only")?.split(",");
const TASKSET_DIR = argOf("taskset", "benchmark/taskset-l1l2")!;

const taskset = JSON.parse(
  readFileSync(resolve(process.cwd(), "..", "..", TASKSET_DIR, "tasks.json"), "utf8"),
) as { tasks: TaskDef[] };

let tasks = taskset.tasks;
if (ONLY) tasks = tasks.filter((t) => ONLY.includes(t.id));

const REPO_ROOT = resolve(process.cwd(), "..", "..");
console.error(`[runner] cwd=${process.cwd()} REPO_ROOT=${REPO_ROOT}`);

function resetWorkspace(fixtureDir: string): void {
  const abs = resolve(REPO_ROOT, TASKSET_DIR, fixtureDir);
  console.error(`[reset] GIT_BIN=${GIT_BIN} gitExists=${existsSync(GIT_BIN)} dirExists=${existsSync(abs)} cwd=${process.cwd()}`);
  execFileSync(GIT_BIN, ["checkout", "--", "."], { cwd: abs, env: process.env });
  execFileSync(GIT_BIN, ["clean", "-fdq"], { cwd: abs, env: process.env });
}

async function createTask(request: string, workspaceAbs: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest: request, workspace: workspaceAbs }),
  });
  if (!res.ok) throw new Error(`createTask ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

const TERMINAL = new Set(["COMPLETE", "STOP", "FAILED", "CANCELLED"]);

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForTerminal(id: string, timeoutMs = 900_000): Promise<{ status: string; attempt: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(5000);
    const res = await fetch(`${BASE_URL}/api/v1/tasks/${id}`);
    const d = (await res.json()) as { status: string; attempt: number };
    if (TERMINAL.has(d.status)) return d;
    if (d.status === "ASK_USER") {
      // Baseline 模擬：知識缺口時核准 → 模型純憑自身能力繼續（無新證據注入）
      await fetch(`${BASE_URL}/api/v1/tasks/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    }
  }
  return { status: "TIMEOUT", attempt: -1 };
}

async function getVerifications(id: string): Promise<Array<{ verifier: string; status: string }>> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/tasks/${id}/logs`);
    const d = (await res.json()) as {
      verifications: Array<Record<string, unknown>>;
    };
    return d.verifications.map((v) => ({
      verifier: String(v.verifier),
      status: String(v.status),
    }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const outDir = resolve(REPO_ROOT, "benchmark/results/l1l2");
  mkdirSync(outDir, { recursive: true });
  const results: RunResult[] = [];

  for (const t of tasks) {
    const workspaceAbs = resolve(REPO_ROOT, TASKSET_DIR, t.workspace);
    for (let run = 1; run <= RUNS; run++) {
      resetWorkspace(t.workspace);
      console.log(`▶ [${t.id}] mode=${MODE} run=${run}`);
      const started = Date.now();
      let cpId = "";
      let terminal = { status: "ERROR", attempt: 0 };
      try {
        cpId = await createTask(t.request, workspaceAbs);
        terminal = await waitForTerminal(cpId);
      } catch (err) {
        terminal = { status: `ERROR: ${(err as Error).message}`.slice(0, 80), attempt: -1 };
      }
      const verifications = cpId ? await getVerifications(cpId) : [];
      const allPass =
        terminal.status === "COMPLETE" &&
        verifications.length > 0 &&
        verifications.every((v) => v.status === "PASS");
      const result: RunResult = {
        taskId: cpId,
        fixtureId: t.id,
        level: t.level,
        mode: MODE,
        run,
        status: terminal.status,
        success: allPass,
        attempts: terminal.attempt,
        durationSec: Math.round((Date.now() - started) / 1000),
        verifications,
      };
      results.push(result);
      console.log(
        `  → ${result.status} success=${result.success} attempts=${result.attempts} ${result.durationSec}s`,
      );
      writeFileSync(
        `${outDir}${MODE}-run${run}-${t.id}.json`,
        JSON.stringify(result, null, 2),
      );
    }
  }

  // 摘要
  const byKey = new Map<string, RunResult[]>();
  for (const r of results) {
    const k = `${r.level}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  console.log("\n=== 摘要 ===");
  for (const [level, rs] of [...byKey.entries()].sort()) {
    const succ = rs.filter((r) => r.success).length;
    console.log(`${level}: ${succ}/${rs.length} success`);
  }
  writeFileSync(`${outDir}${MODE}-summary.json`, JSON.stringify(results, null, 2));
  console.log(`results → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
