#!/usr/bin/env python3
"""
T031 Architecture Validation Gate (validation_gate.py)

實作 Spec §38 Architecture Validation Gate：
- CP Gain ≥ +15pp → PASS（可進入 Phase 6+）
- CP Gain < +15pp → FAIL（需回頭修 Research/Policy/Verification 設計）

用法：
  python scripts/validation_gate.py --metrics results-keep/t031_metrics.json --output results-keep/t031_gate_result.json
"""

import json
import os
import sys
import argparse
from dataclasses import dataclass, asdict
from typing import Dict, Any, Optional


@dataclass
class GateResult:
    """Gate 判定結果"""
    passed: bool
    cp_gain_pp: float
    threshold_pp: float
    reason: str
    details: Dict[str, Any]


def evaluate_gate(metrics_path: str) -> GateResult:
    """根據 metrics JSON 評估 Gate"""
    with open(metrics_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    cp_gain = data.get("cp_gain", {})
    cp_gain_pp = cp_gain.get("cp_gain_pp", 0.0)
    threshold_pp = 15.0  # §38: CP Gain ≥ +15pp

    # 額外檢查：是否有足夠數據
    baselines = data.get("baselines", {})
    has_a = "A" in data.get("baselines", {})
    has_f = "F" in data.get("baselines", {})

    if not has_a or not has_f:
        return GateResult(
            passed=False,
            cp_gain_pp=0.0,
            threshold_pp=threshold_pp,
            reason="Missing baseline A or F data for CP Gain calculation",
            details={"missing_baselines": [b for b in ["A", "F"] if b not in data.get("baselines", {})]}
        )

    cp_gain_pp = data["cp_gain"].get("cp_gain_pp", 0.0)
    passed = cp_gain_pp >= threshold_pp

    # 額外警告：sample size 太小
    total_tasks = sum(m.get("total_tasks", 0) for m in data.get("baselines", {}).values())
    sample_warning = ""
    if total_tasks < 50:
        sample_warning = f" (Warning: only {total_tasks} total task results, statistical significance limited)"

    return GateResult(
        passed=passed,
        cp_gain_pp=cp_gain_pp,
        threshold_pp=threshold_pp,
        reason=f"CP Gain {cp_gain_pp:.1f}pp {'≥' if passed else '<'} {threshold_pp}pp threshold{sample_warning}",
        details={
            "cp_gain_pp": cp_gain_pp,
            "threshold_pp": threshold_pp,
            "success_rate_a": data["cp_gain"].get("success_rate_a", 0),
            "success_rate_f": data["cp_gain"].get("success_rate_f", 0),
            "total_task_results": sum(m.get("total_tasks", 0) for m in data.get("baselines", {}).values()),
            "sample_warning": bool(sample_warning),
        }
    )


def main():
    parser = argparse.ArgumentParser(description="T031 Architecture Validation Gate")
    parser.add_argument("--metrics", default="results-keep/t031_metrics.json", help="Metrics JSON input")
    parser.add_argument("--output", default="results-keep/t031_gate_result.json", help="Output JSON path")
    parser.add_argument("--threshold", type=float, default=15.0, help="CP Gain threshold in percentage points")
    args = parser.parse_args()

    if not os.path.exists(args.metrics):
        print(f"❌ Metrics file not found: {args.metrics}", file=sys.stderr)
        sys.exit(1)

    result = evaluate_gate(args.metrics)

    # 儲存結果
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(asdict(result), f, indent=2, ensure_ascii=False)

    # 輸出判定
    status = "✅ PASS" if result.passed else "❌ FAIL"
    print(f"{status} Architecture Validation Gate")
    print(f"  CP Gain: {result.cp_gain_pp:.1f}pp (threshold: {result.threshold_pp:.1f}pp)")
    print(f"  Reason: {result.reason}")

    if not result.passed:
        sys.exit(1)


if __name__ == "__main__":
    main()