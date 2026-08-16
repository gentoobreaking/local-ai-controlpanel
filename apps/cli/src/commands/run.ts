// 基準執行指令（T033 §34）：cp run / cp baseline run。
// 直接驅動既有 benchmark/runners/baseline-runner.ts（T030 驗證過的 runner），
// 避免在 CLI 重複一份跑分邏輯。

import { spawn } from "node:child_process";
import { parseArgs, CliUsageError } from "../flags.js";
import type { CliContext } from "../context.js";
import type { CommandResult } from "../command-types.js";
import { repoRoot } from "../paths.js";

const BASELINE_RE = /^(all|[A-F])$/i;

function usage(msg: string): CommandResult {
  return { code: 2, lines: [msg] };
}

function baselineFromFlags(flags: Map<string, string | undefined>): string {
  const b = flags.get("--baseline") ?? "all";
  if (!BASELINE_RE.test(b)) {
    throw new CliUsageError(`未知 baseline: ${b}。可用: all, A, B, C, D, E, F`);
  }
  return b.toUpperCase();
}

function spawnRunner(
  extra: string[],
  root: string = repoRoot(),
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "benchmark/runners/baseline-runner.ts", ...extra], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(`[cp] 啟動 baseline-runner 失敗: ${err.message}\n`);
      resolve({ code: 1 });
    });
    child.on("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

// ---- cp run <task_id> [--baseline A-F] --------------------------------

export async function runSingle(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(
    args,
    ["--baseline", "--tasks", "--mode"],
    ["--keep", "--nowatch"],
  );
  if (positionals.length !== 1) {
    return usage("用法: cp run <task_id> [--baseline A-F|all] [--mode llama|stub] [--keep]");
  }
  const taskId = positionals[0]!;
  const taskFilter = flags.get("--tasks") ? `${flags.get("--tasks")},${taskId}` : taskId;
  const baseline = baselineFromFlags(flags);

  const extra = [`--baseline=${baseline}`, `--tasks=${taskFilter}`];
  const mode = flags.get("--mode");
  if (mode) extra.push(`--mode=${mode}`);
  if (bools.has("--keep")) extra.push("--keep");

  process.stdout.write(`[cp] baseline-runner args: ${extra.join(" ")}\n`);
  const { code } = await spawnRunner(extra);
  return {
    code,
    lines: [
      code === 0
        ? `完成: 任務 ${taskId}（baseline ${baseline}）跑分結果已存至 results-keep/t030_baseline_abef/`
        : `失敗: 任務 ${taskId}（baseline ${baseline}）exit=${code}`,
    ],
  };
}

// ---- cp baseline run [--lang] [--baseline A-F] -------------------------

export async function baselineRun(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(
    args,
    ["--lang", "--language", "--baseline", "--max-tasks", "--tasks", "--mode"],
    ["--keep"],
  );
  const baseline = baselineFromFlags(flags);
  const extra = [`--baseline=${baseline}`];
  const lang = flags.get("--lang") ?? flags.get("--language");
  if (lang) extra.push(`--language=${lang}`);
  const maxTasks = flags.get("--max-tasks");
  if (maxTasks) extra.push(`--max-tasks=${maxTasks}`);
  const tasks = flags.get("--tasks");
  if (tasks) extra.push(`--tasks=${tasks}`);
  const mode = flags.get("--mode");
  if (mode) extra.push(`--mode=${mode}`);
  if (bools.has("--keep")) extra.push("--keep");

  process.stdout.write(`[cp] baseline-runner args: ${extra.join(" ")}\n`);
  const { code } = await spawnRunner(extra);
  return {
    code,
    lines: [
      code === 0
        ? `完成: Baseline ${baseline} 批次跑分結束（結果於 results-keep/t030_baseline_abef/）`
        : `失敗: Baseline ${baseline} exit=${code}`,
    ],
  };
}