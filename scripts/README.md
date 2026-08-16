# Scripts 使用說明

## export_sqlite_to_csv.py

將 SQLite 資料庫（`e2e.db`）的所有表格匯出為 CSV 檔案，方便分析、畫圖或匯入 Excel/Pandas。

### 安裝需求
- Python 3.8+
- 標準庫（sqlite3, csv, argparse, pathlib），無額外依賴

### 使用方式

```bash
# 進入專案根目錄
cd ~/Projects/local-ai-controlpanel

# 僅匯出 ON mode（預設）
python3 scripts/export_sqlite_to_csv.py

# 匯出 ON + OFF mode（加上 --off-db）
python3 scripts/export_sqlite_to_csv.py --off-db

# 自訂輸入/輸出路徑
python3 scripts/export_sqlite_to_csv.py path/to/input.db path/to/output_dir

# 查看完整說明
python3 scripts/export_sqlite_to_csv.py -h
```

### 參數說明

| 參數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `db_path` | 否 | `results-keep/t023/research-ON--Full-CP-/e2e.db` | 輸入 SQLite 檔案路徑 |
| `output_dir` | 否 | `results-keep/t023/research-ON--Full-CP-/csv_export` | CSV 輸出目錄 |
| `--off-db` | 否 | false | 同時匯出 OFF mode（`research-OFF--Raw-/e2e.db`） |

### 輸出內容

對每個有資料的表格產生一個 CSV 檔案：

| 表格 | 說明 |
|------|------|
| `tasks` | 任務基本資訊（id, request, status, complexity, risk 等） |
| `attempts` | 每次嘗試的記錄（task_id, attempt, worker, model, status 等） |
| `evidence` | Research 階段產出的 evidence（claim, source_uri, confidence 等） |
| `patches` | Worker 產生的 patch（diff, status, files 等） |
| `reflections` | Reflection 階段的失敗分類與重試資訊 |
| `gate_blocks` | Evidence Gate 阻擋記錄 |
| `app_meta` / `evidence_fts*` | 系統中繼資料與全文檢索索引 |

### 範例輸出

```
$ python3 scripts/export_sqlite_to_csv.py --off-db
📂 Exporting: /.../results-keep/t023/research-ON--Full-CP-/e2e.db
📁 Output: /.../results-keep/t023/research-ON--Full-CP-/csv_export
  ✓ app_meta: 1 rows -> .../app_meta.csv
  ✓ attempts: 3 rows -> .../attempts.csv
  ✓ evidence: 3 rows -> .../evidence.csv
  ✓ patches: 6 rows -> .../patches.csv
  ✓ reflections: 3 rows -> .../reflections.csv
  ✓ tasks: 1 rows -> .../tasks.csv
  ...
✅ Done! Exported 21 tables, 23 total rows

📂 Also exporting OFF mode: /.../research-OFF--Raw-/e2e.db
  ✓ app_meta: 1 rows -> .../app_meta.csv
  ✓ gate_blocks: 1 rows -> .../gate_blocks.csv
  ✓ tasks: 1 rows -> .../tasks.csv
  ...
✅ OFF mode: 21 tables, 6 total rows
```

### 後續分析建議

```python
import pandas as pd

# 讀取 CSV
df_tasks = pd.read_csv('csv_export/tasks.csv')
df_attempts = pd.read_csv('csv_export/attempts.csv')
df_evidence = pd.read_csv('csv_export/evidence.csv')
df_patches = pd.read_csv('csv_export/patches.csv')
df_reflections = pd.read_csv('csv_export/reflections.csv')

# 範例分析
print("任務成功率:", df_tasks['status'].value_counts(normalize=True))
print("平均嘗試次數:", df_attempts.groupby('task_id')['attempt'].max().mean())
print("Evidence 平均數:", df_evidence.groupby('task_id').size().mean())
```

### 常見問題

| 問題 | 解決方式 |
|------|----------|
| `python: command not found` | 使用 `python3` |
| `ModuleNotFoundError` | 確認 Python 3.8+，僅用標準庫 |
| 權限錯誤 | `chmod +x scripts/export_sqlite_to_csv.py` |
| 找不到 db 檔案 | 確認路徑正確，或指定絕對路徑 |

---

*腳本位置：`scripts/export_sqlite_to_csv.py`*  
*最後更新：2026-08-15*