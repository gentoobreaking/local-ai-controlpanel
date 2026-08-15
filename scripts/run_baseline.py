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


def main():
    parser = argparse.ArgumentParser(description="Run Baseline A-F for T030")
    parser.add_argument("--baseline", "-b", default="all",
                        help="Baseline group (A-F or 'all')")
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
    args = parser.parse_args()

    all_baselines = ["A", "B", "C", "D", "E", "F"]
    baselines = all_baselines if args.baseline == "all" else [args.baseline.upper()]

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    results = []

    for bl in baselines:
        r = run_baseline(bl, args.tasks, args.mode, args.keep, args.timeout_min)
        results.append(r)

    save_results(results, run_id)

    # Print summary
    print("\n" + "="*60)
    print("📊 BASELINE SUMMARY")
    print("="*60)
    for r in results:
        status = "✅" if r["success"] else "❌"
        print(f"  {status} Baseline {r['baseline']}: exit={r['returncode']}")

    print(f"\n📄 Summary: results-keep/t030_baseline_abef/summary_{run_id}.json")
    print(f"📄 Per-task results: results-keep/t030_baseline_abef/results_*.json")


if __name__ == "__main__":
    main()