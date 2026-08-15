#!/usr/bin/env python3
"""
T031 核心指標計算模組 (compute_metrics.py)

實作 Spec §36 定義的核心 KPI 計算：
- Task Success Rate
- First Attempt Success Rate
- Verification Pass Rate
- Retry Count (平均嘗試次數)
- Hallucination Rate (error-signature 自動分類)
- Unauthorized Mod. Rate
- CP Gain
- Intelligence Efficiency
- Research ROI
- Prevention Rate

用法：
  python scripts/compute_metrics.py --results-dir results-keep/t030_baseline_abef --output results-keep/t031_metrics.json
"""

import json
import os
import sys
import glob
import statistics
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional, Tuple
from collections import defaultdict
from datetime import datetime


@dataclass
class TaskResult:
    """單一 task 在某 baseline 下的結果"""
    baseline: str
    task_id: str
    success: bool
    attempts: int
    evidence_count: int
    final_status: str
    worker_ok: bool
    patch_files: List[str]
    verification: List[Dict[str, str]]
    duration_ms: int
    error: Optional[str] = None


@dataclass
class BaselineMetrics:
    """單一 baseline 的聚合指標"""
    baseline: str
    name: str
    total_tasks: int
    success_tasks: int
    success_rate: float
    first_attempt_success: int
    first_attempt_success_rate: float
    avg_attempts: float
    avg_duration_ms: float
    total_evidence: int
    avg_evidence_per_task: float
    verification_pass_rate: float
    gate_blocks: int
    prevention_rate: float
    hallucination_rate: float
    unauthorized_mod_rate: float
    tasks: List[TaskResult]


@dataclass
class HallucinationClassification:
    """幻覺分類結果"""
    error_signature: str
    category: str  # "module_not_found" | "import_error" | "attribute_error" | "undefined_reference" | "other"
    is_hallucination: bool
    confidence: float


# Baseline 設定矩陣
BASELINE_CONFIG = {
    "A": {"name": "Raw 9B", "policy": False, "research": False, "verification": False},
    "B": {"name": "Research Only", "policy": False, "research": True, "verification": False},
    "C": {"name": "Policy Only", "policy": True, "research": False, "verification": False},
    "D": {"name": "Verification Only", "policy": False, "research": False, "verification": True},
    "E": {"name": "Research + Verification", "policy": False, "research": True, "verification": True},
    "F": {"name": "Full CP", "policy": True, "research": True, "verification": True},
}


def load_all_results(results_dir: str) -> List[TaskResult]:
    """載入結果目錄下所有 JSON 檔案"""
    results = []
    pattern = os.path.join(results_dir, "results_*.json")
    for filepath in glob.glob(pattern):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            for item in data.get("baselines", []):
                results.append(TaskResult(
                    baseline=item.get("baseline", ""),
                    task_id=item.get("taskId", ""),
                    success=item.get("success", False),
                    attempts=item.get("attempts", 0),
                    evidence_count=item.get("evidenceCount", 0),
                    final_status=item.get("finalStatus", ""),
                    worker_ok=item.get("workerOk", False),
                    patch_files=item.get("patchFiles", []),
                    verification=item.get("verification", []),
                    duration_ms=item.get("durationMs", 0),
                    error=item.get("error"),
                ))
        except Exception as e:
            print(f"Warning: Failed to load {filepath}: {e}", file=sys.stderr)
    return results


def compute_baseline_metrics(results: List[TaskResult]) -> Dict[str, BaselineMetrics]:
    """計算每個 baseline 的聚合指標"""
    # 按 baseline 分組
    by_baseline = defaultdict(list)
    for r in results:
        by_baseline[r.baseline].append(r)

    metrics = {}
    for baseline, tasks in by_baseline.items():
        config = BASELINE_CONFIG.get(baseline, {"name": baseline})
        total = len(tasks)
        success_tasks = [t for t in tasks if t.success]
        success_count = len(success_tasks)

        # First attempt success: 第一次嘗試就成功 (attempts == 1 且 success)
        first_attempt_success = sum(1 for t in tasks if t.success and t.attempts <= 1)

        # 平均嘗試次數
        avg_attempts = statistics.mean([t.attempts for t in tasks]) if tasks else 0

        # 平均耗時
        avg_duration = statistics.mean([t.duration_ms for t in tasks]) if tasks else 0

        # Evidence 統計
        total_evidence = sum(t.evidence_count for t in tasks)
        avg_evidence = total_evidence / total if total > 0 else 0

        # Verification pass rate: 有 verification 且全部 PASS
        verified_tasks = [t for t in tasks if t.verification]
        verification_pass = 0
        for t in verified_tasks:
            if all(v.get("status") == "PASS" for v in t.verification):
                verification_pass += 1
        verification_pass_rate = verification_pass / len(verified_tasks) if verified_tasks else 0.0

        # Gate blocks: 最終狀態為 ASK_USER 或 STOP，且非 success
        gate_blocks = sum(1 for t in tasks if t.final_status in ("ASK_USER", "STOP", "BLOCK") and not t.success)

        # Prevention rate
        prevention_rate = gate_blocks / total if total > 0 else 0.0

        # Hallucination rate: 從 error 或 verification 中偵測
        hallucination_count = sum(1 for t in tasks if _detect_hallucination(t))
        hallucination_rate = hallucination_count / total if total > 0 else 0.0

        # Unauthorized mod rate: worker_ok 但 patch 被 gate 擋下
        unauthorized = sum(1 for t in tasks if t.worker_ok and not t.success and t.final_status in ("ASK_USER", "STOP", "BLOCK"))
        unauthorized_mod_rate = unauthorized / total if total > 0 else 0.0

        metrics[baseline] = BaselineMetrics(
            baseline=baseline,
            name=config["name"],
            total_tasks=total,
            success_tasks=success_count,
            success_rate=success_count / total if total > 0 else 0.0,
            first_attempt_success=first_attempt_success,
            first_attempt_success_rate=first_attempt_success / total if total > 0 else 0.0,
            avg_attempts=avg_attempts,
            avg_duration_ms=avg_duration,
            total_evidence=total_evidence,
            avg_evidence_per_task=avg_evidence,
            verification_pass_rate=verification_pass_rate,
            gate_blocks=gate_blocks,
            prevention_rate=prevention_rate,
            hallucination_rate=hallucination_rate,
            unauthorized_mod_rate=unauthorized_mod_rate,
            tasks=tasks,
        )

    return metrics


def _detect_hallucination(task: TaskResult) -> bool:
    """偵測幻覺特徵"""
    # 從 error 或 verification output 中偵測
    text = (task.error or "").lower()
    for v in task.verification:
        text += " " + (v.get("output", "") or "").lower()

    # 常見幻覺特徵關鍵字
    patterns = [
        "modulenotfounderror",
        "importerror",
        "attributeerror",
        "cannot find",
        "undefined",
        "no such file",
        "not defined",
        "hallucinat",
    ]
    return any(p in text for p in patterns)


def compute_cp_gain(metrics: Dict[str, BaselineMetrics]) -> Dict[str, float]:
    """計算 CP Gain (F - A) 及相關對照"""
    if "A" not in metrics or "F" not in metrics:
        return {}

    gain = metrics["F"].success_rate - metrics["A"].success_rate
    return {
        "cp_gain": gain,
        "cp_gain_pp": gain * 100,  # percentage points
        "success_rate_a": metrics["A"].success_rate,
        "success_rate_f": metrics["F"].success_rate,
        "first_attempt_gain_pp": (metrics["F"].first_attempt_success_rate - metrics["A"].first_attempt_success_rate) * 100,
        "avg_attempts_diff": metrics["F"].avg_attempts - metrics["A"].avg_attempts,
    }


def compute_research_roi(metrics: Dict[str, BaselineMetrics]) -> Dict[str, float]:
    """計算 Research ROI = (Success Gain) / Research Cost"""
    # 這裡用簡化計算：Research 的邊際貢獻 / 研究成本
    if "B" not in metrics or "A" not in metrics:
        return {}

    # B 有 research，A 沒有 -> research 的邊際成功率增益
    success_gain = metrics["B"].success_rate - metrics["A"].success_rate
    # 研究成本：evidence count * avg duration (簡化)
    research_cost = metrics["B"].avg_evidence_per_task * metrics["B"].avg_duration_ms / 1000.0  # 秒
    roi = success_gain / research_cost if research_cost > 0 else 0.0

    return {
        "research_roi": roi,
        "success_gain": success_gain,
        "research_cost_sec": research_cost,
    }


def compute_intelligence_efficiency(metrics: Dict[str, BaselineMetrics]) -> Dict[str, float]:
    """計算 Intelligence Efficiency = Task Success / Model Compute (tokens 或 time)"""
    # 簡化：success_rate / avg_duration_ms (per millisecond)
    # 或 success_rate / avg_attempts
    result = {}
    for bl, m in metrics.items():
        if m.avg_duration_ms > 0:
            result[f"{bl}_efficiency_per_sec"] = m.success_rate / (m.avg_duration_ms / 1000.0)
        if m.avg_attempts > 0:
            result[f"{bl}_efficiency_per_attempt"] = m.success_rate / m.avg_attempts
    return result


def classify_hallucination(error_text: str) -> HallucinationClassification:
    """§36.2 error-signature 自動分類"""
    text = (error_text or "").lower()

    if "modulenotfounderror" in text or "importerror" in text:
        return HallucinationClassification("import_error", "module_not_found", True, 0.9)
    if "attributeerror" in text:
        return HallucinationClassification("attribute_error", "attribute_error", True, 0.85)
    if "cannot find" in text or "undefined" in text or "not defined" in text:
        return HallucinationClassification("undefined_reference", "undefined_reference", True, 0.8)
    if "modulenotfounderror" in text:
        return HallucinationClassification("modulenotfound", "module_not_found", True, 0.9)

    return HallucinationClassification("other", "other", False, 0.0)


def count_degraded_tasks(results: List[TaskResult]) -> int:
    """§14.3 規則 3：research_degraded_tasks 計數"""
    count = 0
    for t in results:
        if "degraded" in (t.final_status or "").lower() or "degraded" in (t.error or "").lower():
            count += 1
    return count


def generate_metrics_json(results_dir: str, output_path: str):
    """主入口：讀取結果 -> 計算指標 -> 輸出 JSON"""
    results = load_all_results(results_dir)
    print(f"Loaded {len(results)} task results from {results_dir}")

    metrics = compute_baseline_metrics(results)

    # 計算對照指標
    cp_gain = compute_cp_gain(metrics)
    research_roi = compute_research_roi(metrics)
    intelligence_eff = compute_intelligence_efficiency(metrics)
    degraded_count = count_degraded_tasks(results)

    # 匯總輸出
    output = {
        "generated_at": datetime.now().isoformat(),
        "source_dir": results_dir,
        "total_task_results": len(results),
        "baselines": {bl: asdict(m) for bl, m in metrics.items()},
        "cp_gain": cp_gain,
        "research_roi": research_roi,
        "intelligence_efficiency": intelligence_eff,
        "research_degraded_tasks": degraded_count,
        "baseline_config": BASELINE_CONFIG,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"✅ Metrics saved to {output_path}")

    # 印出摘要
    print("\n=== Baseline Metrics Summary ===")
    for bl in ["A", "B", "C", "D", "E", "F"]:
        if bl in metrics:
            m = metrics[bl]
            print(f"  {bl} ({m.name}):")
            print(f"    Success: {m.success_tasks}/{m.total_tasks} ({m.success_rate:.1%})")
            print(f"    1st Attempt: {m.first_attempt_success}/{m.total_tasks} ({m.first_attempt_success_rate:.1%})")
            print(f"    Avg Attempts: {m.avg_attempts:.1f}")
            print(f"    Gate Blocks: {m.gate_blocks} (Prevention: {m.prevention_rate:.1%})")
            print(f"    Hallucination: {m.hallucination_rate:.1%}")
            print(f"    Unauthorized Mod: {m.unauthorized_mod_rate:.1%}")

    if cp_gain:
        print(f"\n  CP Gain (F-A): {cp_gain['cp_gain_pp']:.1f}pp")

    return output


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="T031 Compute Metrics")
    parser.add_argument("--results-dir", default="results-keep/t030_baseline_abef", help="Baseline results directory")
    parser.add_argument("--output", default="results-keep/t031_metrics.json", help="Output JSON path")
    args = parser.parse_args()

    generate_metrics_json(args.results_dir, args.output)