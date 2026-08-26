#!/usr/bin/env python3
"""Evidence Utilization Metric（§9 驗證量尺）。

衡量 worker patch 與研究檢索證據的詞彙重疊度：
    utilization = |patch_identifiers ∩ evidence_identifiers| / |patch_identifiers|

用途：
    - 高（≥0.6）：patch 的 API/名稱多來自檢索證據 → 研究有效被採用
    - 低（<0.3）：patch 內容與證據無關 → 「檢索了但沒用上」或「模型幻覺」
    - 配對 L1/L2 分級可歸因失敗：檢索不足（evidence 本身缺）vs 理解不足（有證據但未採用）

用法：
    # 從 Control Plane DB 直接取資料
    python3 evidence_utilization.py --task-id TASK-024 \
        --db ../apps/control-plane/.acp-data/control-plane.db

    # 從檔案
    python3 evidence_utilization.py --patch-file patch.diff --evidence-json evidence.json

輸出：JSON 報告（stdout）。
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

# ── 詞彙過濾 ──────────────────────────────────────────────────────────────

PYTHON_KEYWORDS = {
    "False", "None", "True", "and", "as", "assert", "async", "await",
    "break", "class", "continue", "def", "del", "elif", "else", "except",
    "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
    "while", "with", "yield", "match", "case", "self", "cls",
}

BUILTIN_NOISE = {
    "int", "str", "float", "bool", "list", "dict", "set", "tuple", "len",
    "print", "open", "range", "type", "isinstance", "getattr", "setattr",
    "hasattr", "super", "object", "property", "staticmethod", "classmethod",
    "enumerate", "zip", "map", "filter", "sorted", "sum", "min", "max",
    "abs", "all", "any", "repr", "format", "bytes", "bytearray", "frozenset",
}

COMMON_ENGLISH_STOP = {
    "the", "and", "for", "with", "this", "that", "from", "into", "your",
    "are", "not", "but", "can", "will", "must", "should", "return",
    "example", "usage", "param", "args", "kwargs", "file", "files",
    "test", "tests", "function", "method", "class", "module", "package",
    "install", "using", "used", "new", "get", "set", "add", "run",
    "http", "https", "com", "org", "www", "docs", "doc", "readme",
    "github", "gitlab", "pypi", "python", "pydantic", "todo", "fixme",
    "cannot", "error", "errors", "value", "values", "result", "results",
    "name", "names", "type", "types", "version", "versions", "code",
}

IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


def extract_identifiers(text: str) -> set[str]:
    """抽取程式識別字（排除關鍵字/builtins/常見英文停用詞）。"""
    raw = IDENT_RE.findall(text)
    return {
        tok
        for tok in raw
        if tok not in PYTHON_KEYWORDS
        and tok not in BUILTIN_NOISE
        and tok.lower() not in COMMON_ENGLISH_STOP
    }


def patch_added_text(diff: str) -> str:
    """只取新增行（+ 開頭，排除 +++ 標頭）——衡量『新寫的內容』用了什麼。"""
    lines = []
    for line in diff.split("\n"):
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            lines.append(line[1:])
    return "\n".join(lines)



def compute(patch_text: str, evidence_texts: list[str]) -> dict:
    patch_ids = extract_identifiers(patch_added_text(patch_text))
    evidence_ids: set[str] = set()
    per_evidence = []
    for ev in evidence_texts:
        ids = extract_identifiers(ev)
        evidence_ids |= ids
        per_evidence.append(len(ids))
    if not patch_ids:
        return {"utilization": None, "reason": "no identifiers in patch added lines"}
    matched = patch_ids & evidence_ids
    utilization = round(len(matched) / len(patch_ids), 3)
    return {
        "utilization": utilization,
        "verdict": (
            "high" if utilization >= 0.6 else "medium" if utilization >= 0.3 else "low"
        ),
        "patch_identifier_count": len(patch_ids),
        "matched_count": len(matched),
        "matched_sample": sorted(matched)[:20],
        "unmatched_sample": sorted(patch_ids - matched)[:20],
        "evidence_sources": len(evidence_texts),
    }


# ── 資料來源 ──────────────────────────────────────────────────────────────

def load_from_db(task_id: str, db_path: Path) -> tuple[str, list[str]]:
    conn = sqlite3.connect(db_path)
    try:
        patch_row = conn.execute(
            "SELECT diff FROM patches WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        patch_text = patch_row[0] if patch_row else ""
        ev_rows = conn.execute(
            "SELECT claim FROM evidence WHERE task_id = ? ORDER BY created_at",
            (task_id,),
        ).fetchall()
        evidence_texts = [r[0] for r in ev_rows]
        return patch_text, evidence_texts
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--task-id", help="從 CP DB 讀取 patches + evidence")
    src.add_argument("--inline", nargs=2, metavar=("PATCH_FILE", "EVIDENCE_JSON"),
                     help="patch 檔 + 證據 JSON 陣列檔（每項為字串）")
    ap.add_argument("--db", default=".acp-data/control-plane.db", help="control-plane DB 路徑")
    args = ap.parse_args()

    if args.task_id:
        patch_text, evidence_texts = load_from_db(args.task_id, Path(args.db))
    else:
        patch_file, ev_file = args.inline
        patch_text = Path(patch_file).read_text(encoding="utf-8")
        evidence_texts = json.loads(Path(ev_file).read_text(encoding="utf-8"))

    report = {"taskId": args.task_id}
    if not patch_text:
        report.update({"utilization": None, "reason": "no patch found"})
    elif not evidence_texts:
        report.update({"utilization": None, "reason": "no evidence recorded"})
    else:
        report.update(compute(patch_text, evidence_texts))
    print(json.dumps(report, ensure_ascii=False, indent=2))

    # 有結果且低利用率 → 提示碼非零（供 CI 判讀）；None（無資料）視為中性
    util = report.get("utilization")
    if isinstance(util, float):
        return 0 if util >= 0.3 else 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
