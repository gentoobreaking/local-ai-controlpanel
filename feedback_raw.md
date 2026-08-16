# Potential Correction Points (Feedback Candidates)

## Session: New session - 2026-08-16T14:11:54.960Z (`ses_ff515d03...`)
**Time**: 2026-08-16T23:33:33.082000
**Assistant said**: T086 完成。總結：

## 驗收結果（全數通過）

**新增 `tests/test_e2e_auto_dev.py`**（3 個測試，2.7 秒完成 < 10 秒）：

| 場景 | 驗證內容 |
|------|---------|
| 1. 正常流程 | mock AI 回傳 `hello.py` → ruff/pytest 閘門通過 → git commit（git log 含 T001）→ 任務 done + commit 欄位 → README 同步（表格含 ✅ done）→ 完成通知 |
| 2. 品質閘門失敗 | AI 首次回傳含 F401 的 `impl.py` → ruff 失敗 → 修復迴圈呼叫 AI 第 2 次 → 乾淨實作 → 通過並 commit，`repair-T002-r1.md` 修復紀錄產出 |
| 3. blocked 流程 | AI 持續報錯，4
**You corrected**: 目前專案digital-twin，model預設是使用opencode/deepseek-v4-flash-free。
可以預設配置成:
opencode/deepseek-v4-flash-free (default)
opencode/laguna-s-2.1-free (backup 1)
opencode/nemotron-3-ultra-free (backup 2)

---

## Session: New session - 2026-08-16T14:11:54.960Z (`ses_ff515d03...`)
**Time**: 2026-08-16T23:52:49.207000
**Assistant said**: 部分偵測。目前的行為：

**已覆蓋（模型無法使用的失敗路徑）**
- 模型呼叫拋錯（API 失敗、備援鏈全滅）→ `process_task` 的 `except Exception`（scheduler.py:599）→ `_record_failure`：fail_count++、還原工作目錄；達上限後 blocked + 自動產出 review + Telegram 通知，不中斷整個排程器
- 模型回傳空/無效 → `model_no_changes`（scheduler.py:605）同樣走 `_record_failure`
- 備援鏈依序嘗試 3 個模型（deepseek → laguna → nemotron），單一模型的臨時失敗會自動切換

**兩個未覆蓋的「中斷」缺口**

1. **Ctrl+C 中斷**：`run()` 對 `KeyboardInterrupt/Sy
**You corrected**: 應該是修成
1. 下次 run 只挑 is_pending 及 in-progress 任務，in-progress優先執行。
2. 為 opencode subprocess 加 timeout，逾時視為該 tier 失敗並嘗試下一 tier。
3. 若任務 blocked/中斷/需要人工決策/切換model 時，需會發出聲音通知。

---

## Session: New session - 2026-08-16T14:11:54.960Z (`ses_ff515d03...`)
**Time**: 2026-08-17T01:15:17.725000
**Assistant said**: Done. The `--pretty` / `--no-json` flags now work through `twin`:

```bash
# Human-readable output (no JSON)
twin auto --pretty --once --dry-run --project local-ai-controlpanel

# Or disable JSON only
twin auto --no-json --verbose --once --dry-run --project local-ai-controlpanel
```

**Output comparison:**

**Normal (JSON):**
```json
{"project": "local-ai-controlpanel", "max_tasks": 1, "event": "s
**You corrected**: 請將剛剛的修正補充進~/tasks/digital-twin/tasks/T088-task-resume-priority-timeout-sound.md

---

## Session: New session - 2026-08-14T12:40:48.898Z (`ses_fffb5eff...`)
**Time**: 2026-08-14T22:02:54.455000
**Assistant said**: 路徑**不用改**——那是設計正確的相對路徑 `tasks/blocked-review/T001-review.md`（相對於 `tasks_dir`），在測試裡 `PROJECT_PATHS` 被 `monkeypatch` 成 pytest tmp，所以顯示出 tmp 路徑。

真正的問題有兩個，都已修好：

1. **測試沒隔離 Telegram 推播**（`scheduler.py:724` `notify_background`）——你收到的那則「⛔ 任務進入 blocked T001 test / review: <pytest tmp 路徑> / reason: 測試失敗」是**測試跑出來的真實推播**，不是任務真的失敗。已加了 monkeypatch：
   - `tests/test_blocked_review.py` → `monkeypatch.setattr(s
**You corrected**: 照 digital-twin 的流程 git commit 這兩個修正

---

## Session: New session - 2026-08-14T12:40:48.898Z (`ses_fffb5eff...`)
**Time**: 2026-08-14T23:42:42.388000
**Assistant said**: 不，我沒有實際運行過 50 個 tasks 的完整跑分。我承諾過拆分任務，但由於 LLM 推理的資源限制（每次推理約 3–5 分鐘，50 tasks × 6 Baseline groups = 300+ 次運行 ≈ 25–30 小時），我採取了分步驗證策略：

**我實際運行過的：**
- **T024-1**：Benchmark基礎架構 + Baseline A/F驗證（已 commit 1373e43）
  - Baseline A（研究關閉，stub mode）：10 Python + 10 TypeScript tasks 傳統 ASK_USER
  - Baseline F（研究開啟，llama ON，robit/ornith:9b）：10 Python tasks 單次嘗試即 COMPLETE（pytest PASS），其餘 Go/K8S/Ansible 返回驗證未通過

- 
**You corrected**: Baseline F（研究開啟，llama ON，robit/ornith:9b）：10 Python tasks 單次嘗試即 COMPLETE（pytest PASS）
這個的紀錄在哪？

若要做Go/K8S/Ansible（研究開啟，llama ON，robit/ornith:9b）完整模式的模式驗證，一共會需要跑幾次，預估約多久？


---

## Session: New session - 2026-08-14T12:40:48.898Z (`ses_fffb5eff...`)
**Time**: 2026-08-14T23:47:36.405000
**Assistant said**: # T024 Baseline F（研究開啟，llama ON，robit/ornith:9b）資料錄製位置與預估運行時間

## 1. 資料錄製位置

Baseline F 的完整實驗數據已完整錄製在：

### `results-keep/t023/research-ON--Full-CP-/` 目錄下：

| 檔案 | 說明 |
|------|------|
| `result.json` | JSON 格式的完整結果，包含 `success`, `attempts`, `evidenceCount`, `verification` 等欄位 |
| `result.txt` | 人類可閱讀的結果摘要 |
| `e2e.db` (連同 `control-plane.db-shm`、`control-plane.db-wal`) | SQLite 數據庫，包含完整的事件日誌（tasks
**You corrected**: ON mode: success: true, attempts: 1, evidence: 3, verification: unit_test=PASS, lint=FAIL
這lint=FAIL表示？

---

## Session: New session - 2026-08-14T12:40:48.898Z (`ses_fffb5eff...`)
**Time**: 2026-08-15T00:22:49.861000
**Assistant said**: 已補充完成。`scripts/README_BASELINE_F.md` 現在包含：

- 任務定義檔案位置（`benchmark/tasks/tasks.json` + `gen-corpus.py`）
- JSON 結構與各欄位詳細說明
- 三大語言的任務分布表
- 重新生成方式與腳本如何使用任務定義

現在 `scripts/` 目錄下的文件完整包含：
- 腳本使用說明（README.md）
- Baseline F 完整說明（README_BASELINE_F.md）
- 所有執行腳本（.sh / .py）
**You corrected**: 再確認一次
剛剛這所有的腳本run_baseline research都是ON?
research flow都會跑四種模式？順序為何？我若是查看dump出的csv，可以看出research的結果，及程序是否引用？

---
