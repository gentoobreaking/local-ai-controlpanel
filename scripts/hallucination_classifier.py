#!/usr/bin/env python3
"""
T031 幻覺分類器 (hallucination_classifier.py)

實作 Spec §36.2 error-signature 自動分類：
- ModuleNotFoundError / ImportError → hallucinated module/symbol
- AttributeError → hallucinated field/method
- Cannot find symbol / undefined reference → 編譯期幻覺（Go/Rust）

原則：禁止 LLM-as-judge 進報告數字；人樣本校正（N≈20–50、Cohen's κ ≥ 0.7）為補充項。

用法：
  python scripts/hallucination_classifier.py --input results-keep/t030_baseline_abef --output results-keep/t031_hallucination.csv
"""

import json
import os
import sys
import glob
import csv
import re
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional, Tuple
from collections import defaultdict


@dataclass
class HallucinationClassification:
    """幻覺分類結果"""
    error_signature: str
    category: str  # "module_not_found" | "import_error" | "attribute_error" | "undefined_reference" | "syntax_error" | "other"
    is_hallucination: bool
    confidence: float
    matched_pattern: str
    raw_error: str


# 幻覺特徵模式 (優先序由高到低)
HALLUCINATION_PATTERNS = [
    # (regex pattern, category, confidence)
    (r"modulenotfounderror|no module named", "module_not_found", 0.95),
    (r"importerror.*(cannot import|no module)", "import_error", 0.9),
    (r"attributeerror|object has no attribute|'.*' object has no attribute", "attribute_error", 0.85),
    (r"cannot find (symbol|module|file|reference)", "undefined_reference", 0.85),
    (r"undefined (symbol|reference|variable|function)", "undefined_reference", 0.85),
    (r"not defined|name '.*' is not defined", "undefined_reference", 0.8),
    (r"syntaxerror|invalid syntax|unexpected (eof|token|indent)", "syntax_error", 0.9),
    (r"modulenotfounderror", "module_not_found", 0.9),
    (r"no such file or directory", "file_not_found", 0.7),
    (r"permission denied|access denied", "permission_error", 0.6),
    (r"timeout|timed out", "timeout", 0.5),
    (r"connection (refused|reset|error)", "connection_error", 0.5),
]

# 非幻覺特徵 (環境/設定問題)
NON_HALLUCINATION_PATTERNS = [
    r"permission denied",
    r"connection (refused|reset|timeout)",
    r"timeout",
    r"disk (full|quota)",
    r"out of memory",
    r"kill (signal|process)",
]


def classify_error(error_text: str) -> Tuple[str, float, str, bool]:
    """
    分類單一錯誤訊息
    Returns: (category, confidence, matched_pattern, is_hallucination)
    """
    text = (error_text or "").lower()

    # 先檢查非幻覺特徵
    for pattern in NON_HALLUCINATION_PATTERNS:
        if re.search(pattern, text):
            return "environment_error", 0.8, pattern, False

    # 檢查幻覺模式
    for pattern, category, confidence in HALLUCINATION_PATTERNS:
        if re.search(pattern, text):
            return category, confidence, pattern, True

    return "other", 0.0, "", False


def classify_task_error(task_data: dict) -> dict:
    """分類單一 task 的錯誤"""
    error_text = task_data.get("error", "") or ""
    # 也檢查 verification output
    for v in task_data.get("verification", []):
        if v.get("output"):
            error_text += " " + v.get("output", "")

    category, confidence, pattern, is_hallucination = classify_error(error_text)

    return {
        "baseline": task_data.get("baseline", ""),
        "task_id": task_data.get("taskId", ""),
        "error_signature": (task_data.get("error", "") or "")[:200],
        "category": category,
        "is_hallucination": is_hallucination,
        "confidence": confidence,
        "matched_pattern": pattern,
    }


def classify_all_errors(results_dir: str) -> List[dict]:
    """載入所有結果並分類"""
    pattern = os.path.join(results_dir, "results_*.json")
    classifications = []

    for filepath in glob.glob(os.path.join(results_dir, "results_*.json")):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            for item in data.get("baselines", []):
                classifications.append(classify_task_error(item))
        except Exception as e:
            print(f"Warning: Failed to load {filepath}: {e}", file=sys.stderr)

    return classifications


def compute_hallucination_stats(classifications: List[dict]) -> dict:
    """計算幻覺統計"""
    total = len(classifications)
    if total == 0:
        return {}

    hall_count = sum(1 for c in classifications if c["is_hallucination"])
    by_category = defaultdict(int)
    by_baseline = defaultdict(lambda: {"total": 0, "hallucination": 0})

    for c in classifications:
        by_category[c["category"]] += 1
        by_baseline[c["baseline"]]["total"] += 1
        if c["is_hallucination"]:
            by_baseline[c["baseline"]]["hallucination"] += 1

    # 計算各 baseline 的幻覺率
    baseline_rates = {}
    for bl, stats in by_baseline.items():
        baseline_rates[bl] = {
            "total": stats["total"],
            "hallucination": stats["hallucination"],
            "rate": stats["hallucination"] / stats["total"] if stats["total"] > 0 else 0.0
        }

    return {
        "total": total,
        "hallucination_count": hall_count,
        "overall_rate": hall_count / total if total > 0 else 0.0,
        "by_category": dict(by_category),
        "by_baseline": baseline_rates,
    }


def export_csv(classifications: List[dict], output_path: str):
    """匯出分類結果到 CSV"""
    if not classifications:
        return

    fieldnames = ["baseline", "task_id", "error_signature", "category", "is_hallucination", "confidence", "matched_pattern"]
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(classifications)
    print(f"✅ Classification CSV saved to {output_path}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="T031 Hallucination Classifier")
    parser.add_argument("--input", default="results-keep/t030_baseline_abef", help="Results directory")
    parser.add_argument("--output", default="results-keep/t031_hallucination.csv", help="Output CSV path")
    parser.add_argument("--stats-output", default="results-keep/t031_hallucination_stats.json", help="Stats JSON output")
    args = parser.parse_args()

    print(f"🔍 Classifying errors in {args.input}...")
    classifications = classify_all_errors(args.input)
    print(f"Classified {len(classifications)} task errors")

    stats = compute_hallucination_stats(classifications)
    print(f"Overall hallucination rate: {stats.get('overall_rate', 0):.1%}")

    # 儲存詳細分類
    export_csv(classifications, args.output)

    # 儲存統計
    with open(args.stats_output, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)
    print(f"✅ Stats saved to {args.stats_output}")

    # 印出摘要
    print("\n=== Hallucination Stats ===")
    print(f"Total: {stats.get('total', 0)}")
    print(f"Hallucination: {stats.get('hallucination_count', 0)} ({stats.get('overall_rate', 0):.1%})")
    print("\nBy Category:")
    for cat, count in stats.get("by_category", {}).items():
        print(f"  {cat}: {count}")
    print("\nBy Baseline:")
    for bl, data in stats.get("by_baseline", {}).items():
        print(f"  {bl}: {data['hallucination']}/{data['total']} ({data['rate']:.1%})")


if __name__ == "__main__":
    main()