// 指標報告指令（T033 §36）：cp report generate。
// 依序驅動 T031 的 Python 工具鏈：
//   compute_metrics.py → hallucination_classifier.py → validation_gate.py → generate_report.py

import { spawn } from "node:child_process";
import { parseArgs, CliUsageError } from "../flags.js";
import type { CliContext } from "../context.js";
import type { CommandResult } from "../command-types.js";
import { repoRoot } from "../paths.js";

const BASELINE_RE = /^(all|[A-F])$/i;

function runPythonScript(root: string, relative: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("python3", [relative, ...args], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(`[cp] 啟動 ${relative} 失敗: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function reportGenerate(_ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags } = parseArgs(
    args,
    ["--baseline", "--results-dir", "--output-dir"],
    [],
  );
  const baseline = flags.get("--baseline") ?? "all";
  if (!BASELINE_RE.test(baseline)) {
    throw new CliUsageError(`未知 baseline: ${baseline}。可用: all, A, B, C, D, E, F`);
  }
  const root = repoRoot();
  const resultsDir = flags.get("--results-dir") ?? "results-keep/t030_baseline_abef";
  const outputDir = flags.get("--output-dir") ?? "results-keep/t031_reports";
  const metricsOut = "results-keep/t031_metrics.json";
  const gateOut = "results-keep/t031_gate_result.json";
  const hypCsv = "results-keep/t031_hallucination.csv";
  const hypStats = "results-keep/t031_hallucination_stats.json";

  // baseline 參數僅驗證並提示（compute_metrics 目前對全部 run 一起計算）
  if (baseline !== "all") {
    process.stdout.write(
      `[cp] baseline=${baseline} 已指定：指標為全量 run 計算（filter 由 compute_metrics --results-dir 決定）\n`,
    );
  }

  const steps: Array<[string, string[]]> = [
    ["scripts/compute_metrics.py", ["--results-dir", resultsDir, "--output", metricsOut]],
    ["scripts/hallucination_classifier.py", ["--input", resultsDir, "--output", hypCsv, "--stats-output", hypStats]],
    ["scripts/validation_gate.py", ["--metrics", metricsOut, "--output", gateOut]],
    ["scripts/generate_report.py", ["--metrics", metricsOut, "--gate", gateOut, "--hallucination", hypStats, "--output-dir", outputDir]],
  ];

  for (const [script, scriptArgs] of steps) {
    process.stdout.write(`[cp] ${script} ${scriptArgs.join(" ")}\n`);
    const code = await runPythonScript(root, script, scriptArgs);
    if (code === 1 && script === "scripts/validation_gate.py") {
      // §38：Gate 判定 FAIL 是「數據結論」（exit 1），不是工具錯誤——報告仍需生成
      process.stdout.write("[cp] validation_gate: GATE FAIL（CP Gain 未達門檻或數據不足）→ 仍生成報告\n");
      continue;
    }
    if (code !== 0) {
      return { code: 1, lines: [`失敗: ${script} exit=${code}`] };
    }
  }
  return {
    code: 0,
    lines: [`報告已生成: ${outputDir}/benchmark_report_YYYYMMDD.md（另含 JSON/CSV）`],
  };
}