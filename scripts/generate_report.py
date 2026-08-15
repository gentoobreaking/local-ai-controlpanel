#!/usr/bin/env python3
"""
T031 自動化報告生成 (generate_report.py)

實作 Spec §36.3-36.4 自動化報告生成：
- 輸入：results-keep/t030_baseline_abef/ 所有 baseline 結果
- 輸出：results-keep/t031_reports/benchmark_report_YYYYMMDD.md + JSON
- 包含：Baseline A–F 對照表、CP Gain 信賴區間、各指標趨勢圖（ASCII/文字）、Architecture Validation Gate 判定結果

用法：
  python scripts/generate_report.py --metrics results-keep/t031_metrics.json --gate results-keep/t031_gate_result.json --hallucination results-keep/t031_hallucination_stats.json --output-dir results-keep/t031_reports
"""

import json
import os
import sys
import argparse
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List


def format_pct(value: float) -> str:
    return f"{value:.1%}"


def format_pp(value: float) -> str:
    return f"{value:.1f}pp"


def format_num(value: float) -> str:
    return f"{value:.1f}"


def ascii_bar(value: float, max_width: int = 20, max_val: float = 1.0) -> str:
    """生成 ASCII 長條圖"""
    if max_val <= 0:
        return "─" * max_width
    filled = int((value / max_val) * max_width)
    filled = max(0, min(max_width, filled))
    return "█" * filled + "░" * (max_width - filled)


def generate_baseline_table(metrics: Dict[str, Any]) -> str:
    """生成 Baseline 對照表"""
    lines = []
    lines.append("| Baseline | 設定 | Tasks | Success Rate | 1st Attempt | Avg Attempts | Gate Blocks | Prevention | Hallucination | Unauthorized |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")

    baseline_order = ["A", "B", "C", "D", "E", "F"]
    baseline_names = {
        "A": "Raw 9B",
        "B": "Research Only",
        "C": "Policy Only",
        "D": "Verification Only",
        "E": "Research + Verification",
        "F": "Full CP",
    }

    for bl in baseline_order:
        if bl not in metrics:
            continue
        m = metrics[bl]
        lines.append(f"| {bl} | {baseline_names.get(bl, bl)} | {m['total_tasks']} | "
                     f"{format_pct(m['success_rate'])} | {format_pct(m['first_attempt_success_rate'])} | "
                     f"{format_num(m['avg_attempts'])} | {m['gate_blocks']} | "
                     f"{format_pct(m['prevention_rate'])} | {format_pct(m['hallucination_rate'])} | "
                     f"{format_pct(m['unauthorized_mod_rate'])} |")

    return "\n".join(lines)


def generate_metric_charts(metrics: Dict[str, Any]) -> str:
    """生成 ASCII 指標趨勢圖"""
    lines = []
    lines.append("## 指標趨勢圖 (ASCII)")
    lines.append("")

    # Success Rate
    lines.append("### Success Rate")
    for bl in ["A", "B", "C", "D", "E", "F"]:
        if bl not in metrics:
            continue
        m = metrics[bl]
        bar = ascii_bar(m["success_rate"], max_val=1.0)
        lines.append(f"  {bl}: {bar} {format_pct(m['success_rate'])}")
    lines.append("")

    # First Attempt Success Rate
    lines.append("### First Attempt Success Rate")
    for bl in ["A", "B", "C", "D", "E", "F"]:
        if bl not in metrics:
            continue
        m = metrics[bl]
        bar = ascii_bar(m["first_attempt_success_rate"], max_val=1.0)
        lines.append(f"  {bl}: {ascii_bar(m['first_attempt_success_rate'])} {format_pct(m['first_attempt_success_rate'])}")
    lines.append("")

    # Avg Attempts
    lines.append("### Average Attempts (較低越好)")
    max_attempts = max((m.get("avg_attempts", 0) for m in metrics.values()), default=1)
    for bl in ["A", "B", "C", "D", "E", "F"]:
        if bl not in metrics:
            continue
        m = metrics[bl]
        bar = ascii_bar(m["avg_attempts"], max_val=max(5, max_attempts))
        lines.append(f"  {bl}: {bar} {format_num(m['avg_attempts'])}")
    lines.append("")

    # Prevention Rate
    lines.append("### Prevention Rate (Gate Blocks / Total)")
    for bl in ["A", "B", "C", "D", "E", "F"]:
        if bl not in metrics:
            continue
        m = metrics[bl]
        bar = ascii_bar(m["prevention_rate"], max_val=1.0)
        lines.append(f"  {bl}: {bar} {format_pct(m['prevention_rate'])}")
    lines.append("")

    return "\n".join(lines)


def generate_cp_gain_section(cp_gain: Dict[str, float]) -> str:
    """生成 CP Gain 分析段落"""
    if not cp_gain:
        return "## CP Gain Analysis\n\n⚠️ 無法計算 CP Gain：缺少 Baseline A 或 F 數據。\n"

    gain_pp = cp_gain.get("cp_gain_pp", 0)
    status = "✅ PASS" if gain_pp >= 15 else "❌ FAIL"

    lines = []
    lines.append("## CP Gain Analysis")
    lines.append("")
    lines.append(f"**CP Gain (F - A): {gain_pp:+.1f}pp**  {status}  (閾值: ≥ +15pp)")
    lines.append("")
    lines.append(f"- Baseline A Success Rate: {cp_gain.get('success_rate_a', 0):.1%}")
    lines.append(f"- Baseline F Success Rate: {cp_gain.get('success_rate_f', 0):.1%}")
    lines.append(f"- First Attempt Gain: {cp_gain.get('first_attempt_gain_pp', 0):+.1f}pp")
    lines.append(f"- Avg Attempts Diff: {cp_gain.get('avg_attempts_diff', 0):+.1f}")
    lines.append("")
    lines.append("> **Architecture Validation Gate (§38)**: CP Gain ≥ +15pp 才能進入 Phase 6+")
    lines.append("")

    return "\n".join(lines)


def generate_report(metrics_path: str, gate_path: str, hallucination_path: str, output_dir: str) -> Tuple[str, str]:
    """生成完整報告"""

    # 載入資料
    with open(metrics_path, "r", encoding="utf-8") as f:
        metrics_data = json.load(f)
    with open(gate_path, "r", encoding="utf-8") as f:
        gate_data = json.load(f)
    with open(hallucination_path, "r", encoding="utf-8") as f:
        hallucination_data = json.load(f)

    metrics = metrics_data.get("baselines", {})
    cp_gain = metrics_data.get("cp_gain", {})
    research_roi = metrics_data.get("research_roi", {})
    intelligence_eff = metrics_data.get("intelligence_efficiency", {})
    gate = gate_data
    hallucination = hallucination_data

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d %H:%M")
    file_date = now.strftime("%Y%m%d")

    # 生成 Markdown 報告
    lines = []
    lines.append(f"# Benchmark Report - {file_date}")
    lines.append("")
    lines.append(f"> Generated: {date_str}")
    lines.append(f"> Source: `results-keep/t030_baseline_abef/`")
    lines.append("")

    # Executive Summary
    lines.append("## Executive Summary")
    lines.append("")
    total_tasks = sum(m.get("total_tasks", 0) for m in metrics_data.get("baselines", {}).values())
    lines.append(f"- **Total Task Results**: {total_tasks}")
    lines.append(f"- **Baselines Tested**: {len([b for b in ['A','B','C','D','E','F'] if b in metrics_data.get('baselines', {})])}/6")
    lines.append(f"- **Architecture Validation Gate**: {'✅ PASS' if gate.get('passed') else '❌ FAIL'}")
    lines.append(f"- **Hallucination Rate**: {hallucination.get('overall_rate', 0):.1%}")
    lines.append("")

    # CP Gain Section
    lines.append(generate_cp_gain_section(metrics_data.get("cp_gain", {})))

    # Baseline Comparison Table
    lines.append("## Baseline Comparison")
    lines.append("")
    lines.append(generate_baseline_table(metrics))
    lines.append("")

    # Metric Charts
    lines.append(generate_metric_charts(metrics))

    # Research ROI
    if research_roi:
        lines.append("## Research ROI")
        lines.append("")
        lines.append(f"- **Research ROI**: {research_roi.get('research_roi', 0):.4f}")
        lines.append(f"- **Success Gain (B-A)**: {research_roi.get('success_gain', 0):.1%}")
        lines.append(f"- **Research Cost**: {research_roi.get('research_cost_sec', 0):.1f}s/task")
        lines.append("")

    # Intelligence Efficiency
    if metrics_data.get("intelligence_efficiency"):
        lines.append("## Intelligence Efficiency")
        lines.append("")
        for k, v in metrics_data["intelligence_efficiency"].items():
            lines.append(f"- {k}: {v:.4f}")
        lines.append("")

    # Hallucination Analysis
    lines.append("## Hallucination Analysis (§36.2)")
    lines.append("")
    lines.append(f"- **Overall Rate**: {hallucination.get('overall_rate', 0):.1%}")
    lines.append(f"- **Total Errors**: {hallucination.get('total', 0)}")
    lines.append(f"- **Hallucination Count**: {hallucination.get('hallucination_count', 0)}")
    lines.append("")
    lines.append("### By Category")
    for cat, count in hallucination.get("by_category", {}).items():
        lines.append(f"- {cat}: {count}")
    lines.append("")
    lines.append("### By Baseline")
    for bl, data in hallucination.get("by_baseline", {}).items():
        lines.append(f"- {bl}: {data['hallucination']}/{data['total']} ({data['rate']:.1%})")
    lines.append("")

    # Gate Result
    lines.append("## Architecture Validation Gate (§38)")
    lines.append("")
    status = "✅ PASS" if gate.get("passed") else "❌ FAIL"
    lines.append(f"**{status}**")
    lines.append(f"- CP Gain: {gate.get('details', {}).get('cp_gain_pp', 0):.1f}pp (threshold: 15pp)")
    lines.append(f"- Success Rate A: {gate.get('details', {}).get('success_rate_a', 0):.1%}")
    lines.append(f"- Success Rate F: {gate.get('details', {}).get('success_rate_f', 0):.1%}")
    lines.append(f"- Total Task Results: {gate.get('details', {}).get('total_task_results', 0)}")
    lines.append(f"- Reason: {gate.get('reason', '')}")
    lines.append("")

    # Footer
    lines.append("---")
    lines.append(f"*Report generated at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*")
    lines.append(f"*Data source: `results-keep/t030_baseline_abef/`*")

    markdown = "\n".join(lines)

    # 寫入檔案
    output_dir_path = Path(output_dir)
    output_dir_path.mkdir(parents=True, exist_ok=True)

    md_path = output_dir_path / f"benchmark_report_{file_date}.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(markdown)

    # 也輸出 JSON 機器可讀版本
    json_output = {
        "generated_at": datetime.now().isoformat(),
        "markdown_path": str(md_path),
        "summary": {
            "total_task_results": sum(m.get("total_tasks", 0) for m in json.loads(open(metrics_path).read()).get("baselines", {}).values()),
            "gate_passed": gate.get("passed", False),
            "cp_gain_pp": json.loads(open(metrics_path).read()).get("cp_gain", {}).get("cp_gain_pp", 0),
            "hallucination_rate": json.loads(open(hallucination_path).read()).get("overall_rate", 0),
        },
        "baselines": {bl: m for bl, m in metrics.items()},
    }
    json_path = output_dir_path / f"benchmark_report_{file_date}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_output, f, indent=2, ensure_ascii=False)

    # 也輸出 CSV 明細
    csv_path = output_dir_path / f"benchmark_report_{file_date}.csv"
    import csv
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Baseline", "Name", "Tasks", "Success Rate", "1st Attempt", "Avg Attempts",
                        "Gate Blocks", "Prevention Rate", "Hallucination", "Unauthorized Mod"])
        for bl in ["A", "B", "C", "D", "E", "F"]:
            if bl in metrics:
                m = metrics[bl]
                writer.writerow([bl, {"A":"Raw 9B","B":"Research Only","C":"Policy Only","D":"Verification Only","E":"Research+Verification","F":"Full CP"}[bl],
                                m["total_tasks"], f"{m['success_rate']:.3f}", f"{m['first_attempt_success_rate']:.3f}",
                                m["avg_attempts"], m["gate_blocks"], f"{m['prevention_rate']:.3f}",
                                f"{m['hallucination_rate']:.3f}", f"{m['unauthorized_mod_rate']:.3f}"])

    return str(md_path), str(json_path)


def main():
    parser = argparse.ArgumentParser(description="T031 Generate Report")
    parser.add_argument("--metrics", default="results-keep/t031_metrics.json", help="Metrics JSON input")
    parser.add_argument("--gate", default="results-keep/t031_gate_result.json", help="Gate result JSON input")
    parser.add_argument("--hallucination", default="results-keep/t031_hallucination_stats.json", help="Hallucination stats JSON input")
    parser.add_argument("--output-dir", default="results-keep/t031_reports", help="Output directory")
    args = parser.parse_args()

    for p in [args.metrics, args.gate, args.hallucination]:
        if not os.path.exists(p):
            print(f"❌ Required file not found: {p}", file=sys.stderr)
            sys.exit(1)

    md_path, json_path = generate_report(args.metrics, args.gate, args.hallucination, args.output_dir)
    print(f"✅ Report generated:")
    print(f"  Markdown: {md_path}")
    print(f"  JSON: {json_path}")
    print(f"  CSV: {args.output_dir}/benchmark_report_{datetime.now().strftime('%Y%m%d')}.csv")


if __name__ == "__main__":
    main()