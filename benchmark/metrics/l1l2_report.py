#!/usr/bin/env python3
"""L1/L2 Benchmark 報告：彙總 off/on 結果 → CP Gain 分析 + evidence_utilization。"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results" / "l1l2"
LEVELS = ["L0", "L1", "L2"]


def load_runs() -> list[dict]:
    runs: list[dict] = []
    for f in sorted(RESULTS_DIR.glob("*-summary.json")):
        mode = f.name.replace("-summary.json", "")
        for r in json.loads(f.read_text()):
            r["mode"] = mode
            runs.append(r)
    return runs


def success_rate(runs: list[dict]) -> float:
    if not runs:
        return float("nan")
    return sum(1 for r in runs if r["success"]) / len(runs)


def main() -> int:
    runs = load_runs()
    if not runs:
        print("no results found in", RESULTS_DIR)
        return 1

    by_lm: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in runs:
        by_lm[(r["level"], r["mode"])].append(r)

    lines: list[str] = ["# L1/L2 Benchmark Report\n"]
    lines.append("| Level | Mode | Runs | Success | Success Rate | Avg Attempts | Avg Duration (s) |")
    lines.append("|---|---|---|---|---|---|---|")
    stats: dict[tuple[str, str], dict] = {}
    for level in LEVELS:
        for mode in ("off", "on"):
            rs = by_lm.get((level, mode), [])
            if not rs:
                continue
            sr = success_rate(rs)
            avg_att = sum(r["attempts"] for r in rs if r["attempts"] > 0) / max(
                1, len([r for r in rs if r["attempts"] > 0])
            )
            avg_dur = sum(r["durationSec"] for r in rs) / len(rs)
            stats[(level, mode)] = {"sr": sr, "n": len(rs)}
            lines.append(
                f"| {level} | {mode} | {len(rs)} | {succ} | {sr:.0%} | {avg_att:.1f} | {avg_dur:.0f} |"
            )

    # CP Gain
    lines.append("\n## CP Gain（research ON − OFF，成功百分點）\n")
    gain_lines = []
    for level in LEVELS:
        off = stats.get((level, "off"))
        on = stats.get((level, "on"))
        if off and on:
            gain = (on["sr"] - off["sr"]) * 100
            verdict = {
                "L0": "≈0 預期內（量測無偏）",
                "L1": "≥20pt → 核心命題成立",
                "L2": "OFF≈0 且 ON>0 → 最強訊號",
            }[level]
            gain_lines.append(f"- **{level}**: {gain:+.0f}pt — {verdict}")
            lines.append(f"- **{level}**: {gain:+.0f}pt")
    lines.extend(gain_lines)

    # evidence utilization（ON 成功的 runs）
    lines.append("\n## Evidence Utilization（research ON）\n")
    db = Path(__file__).resolve().parent.parent.parent / "apps/control-plane/.acp-data-benchmark/control-plane.db"
    for r in runs:
        if r["mode"] != "on" or not r["taskId"]:
            continue
        try:
            out = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parent / "evidence_utilization.py"),
                    "--task-id", r["taskId"],
                    "--db", str(db),
                ],
                capture_output=True, text=True, timeout=30,
            ).stdout
            util = json.loads(out).get("utilization")
            if util is not None:
                lines.append(f"- {r['fixtureId']} run{r['run']}: **{util:.2f}**")
        except Exception as e:  # noqa: BLE001
            lines.append(f"- {r['fixtureId']} run{r['run']}: (error: {e})")

    report = "\n".join(lines) + "\n"
    out_md = RESULTS_DIR / "REPORT.md"
    out_md.write_text(report)
    print(report)
    print(f"report → {out_md}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
