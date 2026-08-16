# Baseline F 批次跑分腳本

針對 Go / Kubernetes / Ansible tasks 執行 Baseline F（研究開啟，llama ON，robit/ornith:9b）驗證。

## 腳本清單

| 腳本 | 說明 | Tasks | 預估時間 |
|------|------|-------|----------|
| `run_baseline_f_go.sh` | Go 11 tasks (T043-T053) | 11 | 1-2 hr |
| `run_baseline_f_kubernetes.sh` | Kubernetes 9 tasks | 9 | 1-2 hr |
| `run_baseline_f_ansible.sh` | Ansible 10 tasks | 10 | 1-2 hr |
| `run_baseline_f_all.sh` | 完整跑分 (Go+K8s+Ansible) | 30 | 4-8 hr |
| `run_baseline_f.py` | Python 版進階腳本（支援參數、結果 JSON 匯出） | 依參數 | 依參數 |

## 快速開始

```bash
cd ~/Projects/local-ai-controlpanel

# 單獨跑某語言
./scripts/run_baseline_f_go.sh
./scripts/run_baseline_f_kubernetes.sh
./scripts/run_baseline_f_ansible.sh

# 完整跑分（30 tasks，預估 4-8 hr）
./scripts/run_baseline_f_all.sh

# Python 進階版（支援參數、JSON 匯出）
python3 scripts/run_baseline_f.py --language go --max-tasks 3
python3 scripts/run_baseline_f.py --language all --max-tasks 5
```

## 環境需求

- **Ollama** 已啟動並載入 `robit/ornith:9b`
  ```bash
  ollama pull robit/ornith:9b
  ollama serve  # 背景執行
  ```
- **Node.js** 環境（已安裝 npx、tsx）
- **專案依賴** 已安裝（`pnpm install`）

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `LLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API 端點 |
| `LLAMA_MODEL` | `robit/ornith:9b` | 模型名稱 |

可在腳本前加環境變數覆蓋：
```bash
LLAMA_BASE_URL=http://192.168.1.100:11434 LLAMA_MODEL=qwen2.5-coder:7b ./scripts/run_baseline_f_go.sh
```

## 輸出結果

所有結果自動儲存至 `results-keep/t024_baseline_f/`：

```
results-keep/t024_baseline_f/
├── go_20260815_143000.log
├── kubernetes_20260815_164500.log
├── ansible_20260815_183000.log
└── go_20260815_143000.json  (Python 版產出)
```

### Python 進階版輸出 JSON 格式
```json
{
  "language": "go",
  "timestamp": "2026-08-15T14:30:00",
  "total": 11,
  "success": 8,
  "failed": 3,
  "avg_time_sec": 245.5,
  "results": [
    {"task_id": "T043", "language": "Go", "success": true, "final_status": "COMPLETE", "elapsed_sec": 180.2},
    {"task_id": "T044", "language": "Go", "success": false, "final_status": "VERIFYING", "elapsed_sec": 420.0}
  ]
}
```

## 預估執行時間

| 語言 | Tasks | Attempts/task | 單次推理 | 總計 |
|------|-------|---------------|----------|------|
| Go | 11 | 4 | ~4 min | ~3 hr |
| Kubernetes | 9 | 4 | ~4 min | ~2.5 hr |
| Ansible | 10 | 4 | ~4 min | ~2.5 hr |
| **總計** | **30** | **4** | **~4 min** | **~8 hr** |

> ⚠️ 實際時間取決於模型響應速度、錯誤重試次數、硬體效能

## 結果分析

```bash
# 查看成功率
grep -h "success:" results-keep/t024_baseline_f/*.log | sort | uniq -c

# 查看平均嘗試次數
python3 -c "
import json, glob
for f in glob.glob('results-keep/t024_baseline_f/*.json'):
    with open(f) as fp: d=json.load(fp)
    print(f'{d[\"language\"]}: {d[\"success\"]}/{d[\"total\"]} success, avg {d[\"avg_time_sec\"]}s')
"
```

## 常見問題

| 問題 | 解決方式 |
|------|----------|
| `ollama: command not found` | 安裝 Ollama：`brew install ollama` |
| `model not found` | `ollama pull robit/ornith:9b` |
| `Connection refused` | 確認 `ollama serve` 正在執行 |
| `timeout` | 增加腳本中的 timeout 參數 |
| 記憶體不足 | 減少同時運行任務，或使用較小模型 |

---

## 任務內容定義

所有 Baseline F 測試的任務內容定義於 **`benchmark/tasks/tasks.json`**，由 **`benchmark/tasks/gen-corpus.py`** 生成。

### 定義檔案位置

```
benchmark/tasks/
├── gen-corpus.py      # 生成腳本
├── tasks.json         # 50 tasks 完整定義
└── .gitkeep
```

### tasks.json 結構

```json
{
  "count": 50,
  "created": "2026-08-14",
  "spec_ref": "§35/§34/§38",
  "tasks": [
    {
      "id": "T043",
      "language": "Go",
      "level": "Level 3: Dependency/API usage",
      "lib": "net/http",
      "request": "Add getStatus(url) using net/http GET → int",
      "research_facts": "Add getStatus",
      "official_doc": "https://pkg.go.dev/net/http"
    },
    ...
  ]
}
```

### 欄位說明

| 欄位 | 說明 | 範例 |
|------|------|------|
| `id` | 任務唯一識別碼 | `T043` |
| `language` | 程式語言 | `Go` / `Kubernetes` / `Ansible` |
| `level` | 難度等級（§35） | `Level 3: Dependency/API usage` |
| `lib` | 核心函式庫 | `net/http` / `kubernetes-client` |
| `request` | 具體實作需求 | `Add getStatus(url) using net/http GET → int` |
| `research_facts` | 需研究的關鍵點 | `Add getStatus` |
| `official_doc` | 官方文檔 URL | `https://pkg.go.dev/net/http` |

### 任務分布

| 語言 | Tasks | Level 分布 | 核心 Library |
|------|-------|-----------|-------------|
| **Go** | 11 (T043–T053) | L3×5, L4×4, L5×2 | `net/http` |
| **Kubernetes** | 9 (T054–T062) | L3×3, L4×4, L5×2 | `kubernetes-client` (Python) |
| **Ansible** | 10 (T063–T072) | L3×4, L4×3, L5×3 | `debug`、`copy`、`jinja2` |

### 重新生成 tasks.json

```bash
cd ~/Projects/local-ai-controlpanel/benchmark/tasks
python3 gen-corpus.py
```

> ⚠️ 重新生成會覆蓋現有 `tasks.json`，請先備份。

### 腳本如何使用任務定義

`run_baseline_f.py` 會：
1. 讀取 `benchmark/tasks/tasks.json`
2. 根據 `--language` 參數篩選對應語言的 tasks
3. 依序執行每個 task 的 Baseline F 驗證
4. 將結果寫入 `results-keep/t024_baseline_f/`

---

*腳本位置：`~/Projects/local-ai-controlpanel/scripts/`*  
*最後更新：2026-08-15*