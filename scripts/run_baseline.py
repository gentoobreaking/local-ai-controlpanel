#!/usr/bin/env python3
"""
T030 Baseline A-E 批次跑分腳本（Python 版）

用法：
  python3 scripts/run_baseline.py --baseline A|B|C|D|E|F|all
                                  --language python
                                  --tasks T023 T024 T025
                                  --max-tasks 10
                                  --mode llama|stub
                                  --keep
                                  --auto-report  # 自動觸發指標計算與報告生成 (T031)
"""

import subprocess
import json
import argparse
import sys
import os
from pathlib import Path
from datetime import datetime

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_baseline(baseline: str, tasks: list, mode: str = "llama", keep: bool = True,
                 max_attempts: int = 4, timeout_min: int = 60):
    """Run a single baseline on specified tasks."""
    cmd = [
        "npx", "tsx", "benchmark/runners/baseline-runner.ts",
        f"--baseline={baseline}",
        f"--mode={mode}",
    ]
    if tasks:
        cmd.append(f"--tasks={' '.join(tasks)}")
    if keep:
        cmd.append("--keep")

    env = os.environ.copy()
    env["LLAMA_BASE_URL"] = env.get("LLAMA_BASE_URL", "http://127.0.0.1:11434")
    env["LLAMA_MODEL"] = env.get("LLAMA_MODEL", "robit/ornith:9b")

    print(f"\n{'='*60}")
    print(f"🚀 Baseline {baseline} — tasks: {', '.join(tasks) if tasks else 'ALL'}")
    print(f"   Mode: {mode} | Ollama: {env['LLAMA_BASE_URL']}")
    print(f"   Timeout/task: {timeout_min}min")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout_min * 60 * max(len(tasks) if tasks else 10, 1),
            env=env,
        )
        output = result.stdout + result.stderr
        print(f"   exit={result.returncode}")
        return {
            "baseline": baseline,
            "success": result.returncode == 0,
            "output": output[-2000:],  # keep last 2000 chars
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        print(f"   TIMEOUT (> {timeout_min}min)")
        return {
            "baseline": baseline,
            "success": False,
            "output": "TIMEOUT",
            "returncode": -1,
        }
    except Exception as e:
        print(f"   ERROR: {e}")
        return {
            "baseline": baseline,
            "success": False,
            "output": str(e),
            "returncode": -1,
        }


def save_results(results: list, run_id: str):
    """Save summary results."""
    out_dir = REPO_ROOT / "results-keep" / "t030_baseline_abef"
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "run_id": run_id,
        "timestamp": datetime.now().isoformat(),
        "results": results,
    }
    out_file = out_dir / f"summary_{run_id}.json"
    with open(out_file, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n📊 Summary saved to: {out_file}")


def run_post_processing(run_id: str):
    """T031: Run metrics computation, hallucination classification, validation gate, and report generation."""
    print("\n" + "="*60)
    print("📈 T031 Post-Processing: Metrics & Report Generation")
    print("="*60)

    # 1. Compute metrics
    print("\n🔢 Step 1: Computing metrics...")
    metrics_cmd = [
        sys.executable, "scripts/compute_metrics.py",
        "--results-dir", "results-keep/t030_baseline_abef",
        "--output", "results-keep/t031_metrics.json"
    ]
    try:
        subprocess.run(metrics_cmd, cwd=str(REPO_ROOT), check=True, capture_output=True, text=True)
        print("   ✅ Metrics computed")
    except subprocess.CalledProcessError as e:
        print(f"   ⚠️ Metrics computation failed: {e.stderr[-500:]}")
        return False

    # 2. Hallucination classification
    print("\n🔍 Step 2: Classifying hallucinations...")
    hallucination_cmd = [
        sys.executable, "scripts/hallucination_classifier.py",
        "--input", "results-keep/t030_baseline_abef",
        "--output", "results-keep/t031_hallucination.csv",
        "--stats-output", "results-keep/t031_hallucination_stats.json"
    ]
    try:
        subprocess.run(hallucination_cmd, cwd=str(REPO_ROOT), check=True, capture_output=True, text=True)
        print("   ✅ Hallucination classified")
    except subprocess.CalledProcessError as e:
        print(f"   ⚠️ Hallucination classification failed: {e.stderr[-500:]}")
        return False

    # 3. Validation gate
    print("\n🚪 Step 3: Running Architecture Validation Gate...")
    gate_cmd = [
        sys.executable, "scripts/validation_gate.py",
        "--metrics", "results-keep/t031_metrics.json",
        "--output", "results-keep/t031_gate_result.json"
    ]
    try:
        result = subprocess.run(gate_cmd, cwd=str(REPO_ROOT), capture_output=True, text=True)
        print(f"   Gate result: {result.stdout.strip()}")
    except subprocess.CalledProcessError as e:
        print(f"   ⚠️ Gate evaluation failed: {e.stderr[-500:]}")
        return False

    # 4. Generate report
    print("\n📄 Step 4: Generating benchmark report...")
    report_cmd = [
        sys.executable, "scripts/generate_report.py",
        "--metrics", "results-keep/t031_metrics.json",
        "--gate", "results-keep/t031_gate_result.json",
        "--hallucination", "results-keep/t031_hallucination_stats.json",
        "--output-dir", "results-keep/t031_reports"
    ]
    try:
        result = subprocess.run(report_cmd, cwd=str(REPO_ROOT), check=True, capture_output=True, text=True)
        print(f"   {result.stdout.strip()}")
        print("   ✅ Report generated")
    except subprocess.CalledProcessError as e:
        print(f"   ⚠️ Report generation failed: {e.stderr[-500:]}")
        return False

    return True


def main():
    parser = argparse.ArgumentParser(description="Run Baseline A-F for T030 + T031 post-processing")
    parser.add_argument("--baseline", "-b", default="all",
                        help="Baseline group (A-F or 'all', comma-separated for multiple)")
    parser.add_argument("--tasks", "-t", nargs="*", default=None,
                        help="Specific task IDs (e.g. T023 T024)")
    parser.add_argument("--max-tasks", "-n", type=int, default=None,
                        help="Limit number of tasks per baseline")
    parser.add_argument("--mode", default="llama", choices=["llama", "stub"],
                        help="Inference mode (llama=real, stub=fast stub)")
    parser.add_argument("--keep", action="store_true",
                        help="Keep failed workspace snapshots")
    parser.add_argument("--timeout-min", type=int, default=60,
                        help="Timeout per task in minutes")
    parser.add_argument("--auto-report", action="store_true",
                        help="Auto-run T031 metrics/report generation after baselines complete")
    args = parser.parse_args()

    all_baselines = ["A", "B", "C", "D", "E", "F"]
    # 支援 comma-separated 或 "all"
    if args.baseline.lower() == "all":
        baselines = all_baselines
    else:
        baselines = [b.strip().upper() for b in args.baseline.split(",") if b.strip()]
        # 驗證 baseline 合法性
        invalid = [b for b in baselines if b not in all_baselines]
        if invalid:
            parser.error(f"Invalid baseline(s): {', '.join(invalid)}. Valid: A, B, C, D, E, F")

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    results = []

    for bl in baselines:
        r = run_baseline(bl, args.tasks, args.mode, args.keep, args.timeout_min)
        results.append(r)

    # Save baseline results
    out_dir = REPO_ROOT / "results-keep" / "t030_baseline_abef"
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "run_id": run_id,
        "timestamp": datetime.now().isoformat(),
        "results": results,
    }
    out_file = out_dir / f"summary_{run_id}.json"
    with open(out_file, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n📊 Summary saved to: {out_file}")

    # Print baseline summary
    print("\n" + "="*60)
    print("📊 BASELINE SUMMARY")
    print("="*60)
    for r in results:
        status = "✅" if r["success"] else "❌"
        print(f"  {status} Baseline {r['baseline']}: exit={r['returncode']}")

    print(f"\n📄 Summary: results-keep/t030_baseline_abef/summary_{run_id}.json")
    print(f"📄 Per-task results: results-keep/t030_baseline_abef/results_*.json")

    # T031 Auto post-processing
    if args.auto_report:
        success = run_post_processing(run_id)
        if success:
            print("\n" + "="*60)
            print("🎉 T031 Post-Processing Complete!")
            print("   📊 Metrics: results-keep/t031_metrics.json")
            print("   🔍 Hallucination: results-keep/t031_hallucination_stats.json")
            print("   🚪 Gate: results-keep/t031_gate_result.json")
            print("   📄 Report: results-keep/t031_reports/")
        else:
            print("\n⚠️ T031 Post-Processing had some issues (see above)")
            sys.exit(1)


if __name__ == "__main__":
    main()