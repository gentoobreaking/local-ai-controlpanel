#!/usr/bin/env python3
"""
SQLite 資料庫匯出 CSV 工具

用法：
  python scripts/export_sqlite_to_csv.py [db_path] [output_dir]

預設：
  db_path: results-keep/t023/research-ON--Full-CP-/e2e.db
  output_dir: results-keep/t023/research-ON--Full-CP-/csv_export
"""

import sqlite3
import csv
import os
import sys
import argparse
import json
from pathlib import Path


def export_db_to_csv(db_path: str, output_dir: str) -> dict:
    """
    將 SQLite 資料庫所有表匯出為 CSV 檔案

    Args:
        db_path: SQLite 檔案路徑
        output_dir: 輸出目錄

    Returns:
        dict: {table_name: row_count}
    """
    db_path = Path(db_path)
    output_dir = Path(output_dir)

    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 取得所有表格名稱
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )]

    result = {}
    for table in tables:
        rows = cur.execute(f"SELECT * FROM {table}").fetchall()
        row_count = len(rows)

        if row_count > 0:
            csv_path = output_dir / f"{table}.csv"
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows([dict(r) for r in rows])
            print(f"  ✓ {table}: {row_count} rows -> {csv_path}")
        else:
            print(f"  - {table}: 0 rows (skipped)")

        result[table] = row_count

    # 新增：若有 patches 和 evidence 表，產生 joined 分析檔
    if "patches" in tables and "evidence" in tables:
        export_patch_evidence_join(cur, output_dir)

    conn.close()
    return result


def export_patch_evidence_join(cur, output_dir: Path):
    """
    產生 patches 與 evidence 的關聯分析 CSV
    檢查 patch 中是否引用了 evidence 的 claim / source_uri
    """
    print("  🔗 Generating patch-evidence join analysis...")

    # 取得所有 evidence
    evidences = cur.execute("SELECT id, claim, source_uri, source_type FROM evidence").fetchall()
    if not evidences:
        print("  - No evidence found, skipping join")
        return

    # 取得所有 patches
    patches = cur.execute("SELECT id, task_id, attempt, path, diff, status, created_at FROM patches").fetchall()
    if not patches:
        print("  - No patches found, skipping join")
        return

    # 建立 evidence 查找字典
    evidence_dict = {e["id"]: e for e in evidences}

    # 分析每個 patch 是否引用了 evidence
    join_rows = []
    for patch in patches:
        patch_id = patch["id"]
        diff = patch["diff"] or ""

        # 檢查每個 evidence 的 claim 或 source_uri 是否出現在 diff 中
        referenced_evidences = []
        for e_id, ev in evidence_dict.items():
            claim = ev["claim"] or ""
            source_uri = ev["source_uri"] or ""

            # 簡單字串匹配：claim 關鍵字或 source_uri 是否出現在 diff 中
            claim_keywords = [w for w in claim.split() if len(w) > 3]  # 只取長度>3的關鍵字
            uri_match = source_uri and source_uri in diff
            claim_match = any(kw.lower() in diff.lower() for kw in claim_keywords)

            if uri_match or claim_match:
                referenced_evidences.append({
                    "evidence_id": e_id,
                    "claim": claim[:100],
                    "source_uri": source_uri,
                    "match_type": "uri" if uri_match else "claim_keyword"
                })

        join_rows.append({
            "patch_id": patch_id,
            "task_id": patch["task_id"],
            "attempt": patch["attempt"],
            "patch_status": patch["status"],
            "patch_files": patch["path"],
            "patch_created_at": patch["created_at"],
            "referenced_evidence_count": len(referenced_evidences),
            "referenced_evidences": json.dumps(referenced_evidences, ensure_ascii=False),
            "has_evidence_reference": "YES" if referenced_evidences else "NO"
        })

    if join_rows:
        csv_path = output_dir / "patch_evidence_join.csv"
        fieldnames = ["patch_id", "task_id", "attempt", "patch_status", "patch_files",
                      "patch_created_at", "referenced_evidence_count", "referenced_evidences",
                      "has_evidence_reference"]
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(join_rows)
        print(f"  ✓ patch_evidence_join: {len(join_rows)} rows -> {csv_path}")
    else:
        print("  - No patches to analyze")


def main():
    parser = argparse.ArgumentParser(description="Export SQLite database to CSV files")
    parser.add_argument(
        "db_path",
        nargs="?",
        default="results-keep/t023/research-ON--Full-CP-/e2e.db",
        help="Path to SQLite database file"
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        default="results-keep/t023/research-ON--Full-CP-/csv_export",
        help="Output directory for CSV files"
    )
    parser.add_argument(
        "--off-db",
        action="store_true",
        help="Also export the OFF mode database (research-OFF--Raw-)"
    )

    args = parser.parse_args()

    # 解析路徑（相對於專案根目錄）
    project_root = Path(__file__).parent.parent
    db_path = project_root / args.db_path
    output_dir = project_root / args.output_dir

    print(f"📂 Exporting: {db_path}")
    print(f"📁 Output: {output_dir}")

    try:
        result = export_db_to_csv(str(db_path), str(output_dir))
        total_rows = sum(result.values())
        print(f"\n✅ Done! Exported {len(result)} tables, {total_rows} total rows")

        # 若指定 --off-db，也匯出 OFF 模式資料庫
        if args.off_db:
            off_db = db_path.parent.parent / "research-OFF--Raw-" / "e2e.db"
            off_output = output_dir.parent / "research-OFF--Raw-_csv_export"
            if off_db.exists():
                print(f"\n📂 Also exporting OFF mode: {off_db}")
                off_result = export_db_to_csv(str(off_db), str(off_output))
                off_total = sum(off_result.values())
                print(f"✅ OFF mode: {len(off_result)} tables, {off_total} total rows")
            else:
                print(f"\n⚠️  OFF mode database not found: {off_db}")

    except FileNotFoundError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()