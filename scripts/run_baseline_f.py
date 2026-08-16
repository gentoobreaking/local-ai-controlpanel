#!/usr/bin/env python3
"""
Baseline F (研究開啟，llama ON) 批次跑分腳本

分別跑 Go、Kubernetes、Ansible tasks 的 Baseline F（研究開啟，llama ON）。

用法：
  python3 scripts/run_baseline_f.py --language go|kubernetes|ansible|all
  python3 scripts/run_baseline_f.py --language all --max-tasks 5
  python3 scripts/run_baseline_f.py --language go --model robit/ornith:9b --base-url http://127.0.0.1:11434
"""

import subprocess
import json
import argparse
import sys
import time
from pathlib import Path
from datetime import datetime


def load_tasks(language: str) -> list:
    """從 tasks.json 載入指定語言的 tasks"""
    tasks_path = Path(__file__).parent.parent / "benchmark" / "tasks" / "tasks.json"
    with open(tasks_path) as f:
        data = json.load(f)

    tasks = [t for t in data["tasks"] if t["language"].lower() == language.lower()]
    return tasks


def run_task(task: dict, model: str, base_url: str, keep: bool = True, mode: str = "llama") -> dict:
    """執行單一 task 的 Baseline F（研究開啟，ON 模式）"""
    task_id = task["id"]
    task_num = int(task["id"][1:])  # T043 -> 43

    cmd = [
        "npx", "tsx", "benchmark/runners/e2e-runner.ts",
        "--mode", mode,
        "--only", "on",
        "--keep" if True else "",
    ]

    env = {
        **__import__("os").environ,
        "LLAMA_BASE_URL": base_url,
        "LLAMA_MODEL": "robit/ornith:9b",
    }

    print(f"\n{'='*60}")
    print(f"🚀 Running {task['id']} ({task['language']}) - {task['request'][:50]}...")
    print(f"   Model: robit/ornith:9b")
    print(f"   Base URL: {base_url}")
    start = time.time()

    try:
        result = subprocess.run(
            cmd,
            cwd=__import__("os").path.dirname(__file__) + "/..",
            capture_output=True,
            text=True,
            timeout=600,  # 10 分鐘超時
            env=env
        )
        elapsed = time.time() - start

        # 解析輸出
        output = result.stdout + result.stderr
        success = "success:      true" in output
        final_status = "UNKNOWN"
        for line in output.split("\n"):
            if "finalStatus:" in line:
                final_status = line.split("finalStatus:")[1].strip()
                break

        return {
            "task_id": task["id"],
            "language": task["language"],
            "success": success,
            "final_status": final_status,
            "elapsed_sec": round(elapsed, 1),
            "returncode": result.returncode,
        }

    except subprocess.TimeoutExpired:
        return {
            "task_id": task["id"],
            "language": task["language"],
            "success": False,
            "final_status": "TIMEOUT",
            "elapsed_sec": 600,
            "returncode": -1,
        }
    except Exception as e:
        return {
            "task_id": task["id"],
            "language": task["language"],
            "success": False,
            "final_status": f"ERROR: {e}",
            "elapsed_sec": 0,
            "returncode": -1,
        }


def run_language(language: str, base_url: str, max_tasks: int = None) -> list:
    """執行指定語言的所有 tasks"""
    tasks = load_tasks(language)
    if max_tasks:
        tasks = tasks[:max_tasks]

    print(f"\n{'='*70}")
    print(f"📦 Starting {language.upper()} Baseline F: {len(tasks)} tasks")
    print(f"{'='*70}")

    results = []
    for i, task in enumerate(tasks, 1):
        print(f"\n[{i}/{len(tasks)}] ", end="")
        result = run_task(task, "robit/ornith:9b", "http://127.0.0.1:11434")
        results.append(result)
        status = "✅" if result["success"] else "❌"
        print(f"   {status} {result['task_id']}: {result['final_status']} ({result['elapsed_sec']}s)")

        # 任務間短暫休息，避免過載
        time.sleep(2)

    return results


def save_results(results: list, language: str):
    """儲存結果到 JSON"""
    output_dir = Path(__file__).parent.parent / "results-keep" / "t024_baseline_f"
    __import__("os").makedirs(results_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = Path(__file__).parent.parent / "results-keep" / "t024_baseline_f" / f"{language}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    summary = {
        "language": language,
        "timestamp": datetime.now().isoformat(),
        "total": len(results),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "avg_time_sec": round(sum(r["elapsed_sec"] for r in results) / len(results), 1) if results else 0,
        "results": results,
    }

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print(f"\n📄 Results saved to: {output_file}")
    return summary


def main():
    parser = argparse.ArgumentParser(description="Run Baseline F (llama ON) for Go/K8S/Ansible tasks")
    parser.add_argument(
        "--language", "-l",
        choices=["go", "kubernetes", "ansible", "all"],
        required=True,
        help="Language group to run"
    )
    parser.add_argument(
        "--max-tasks", "-n",
        type=int,
        default=None,
        help="Limit number of tasks (for testing)"
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:11434",
        help="Ollama base URL"
    )
    parser.add_argument(
        "--model",
        default="robit/ornith:9b",
        help="Model name"
    )
    args = parser.parse_args()

    if args.language == "all":
        languages = ["go", "kubernetes", "ansible"]
    else:
        languages = [args.language]

    all_results = {}
    for lang in languages:
        results = run_language(lang, args.base_url, args.max_tasks)
        summary = save_results(results, args.language if args.language != "all" else lang)
        all_results[lang] = summary

        # 語言間休息
        if len(languages) > 1:
            print(f"\n⏸️  Resting 10 seconds before next language...")
            __import__("time").sleep(10)

    # 總結
    print("\n" + "="*70)
    print("📊 BASELINE F SUMMARY")
    print("="*70)
    for lang, summary in all_results.items():
        print(f"  {lang.upper():12s}: {summary['success']}/{summary['total']} success, "
              f"avg {summary['avg_time_sec']}s/task")


if __name__ == "__main__":
    main()