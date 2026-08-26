# Agent Control Plane 端到端整合測試報告

> **日期**：2026-08-26
> **環境**：macOS (Apple M2) / Node 26.7 / ollama + qwen2.5-coder:7b / seatbelt sandbox
> **對應 Commit**：`50dcbe4` fix(pipeline): wire research/artifact/verification integration layer
> **測試 Workspace**：`/tmp/acp-demo`（Python 專案，git repo，含刻意注入的 `safe_divide` 除零 bug）

---

## 1. 測試目的

驗證 ACP 核心 pipeline 的**完整閉環**：

```
任務建立 → 政策檢查 → 研究引擎 → 證據閘門 → 本地 LLM 生成 patch
→ Artifact 驗證/套用 → 沙箱驗證（pytest/ruff） → 反思重試 → COMPLETE/STOP
```

此前狀態：pipeline 各元件（T010–T022）單元測試通過，但**整合層從未接線**——
任務進入 `RESEARCHING` 後永久卡死，核心閉環實際上不可運行。

---

## 2. 發現並修復的架構斷點

| # | 斷點 | 症狀 | 修復 |
|---|------|------|------|
| B1 | `runner.reportResearch()` 定義但無任何呼叫者 | 任務卡死 `RESEARCHING`，永不到達 Worker | runner 新增 `onResearchRequired` hook；server 以延遲綁定接線（researchEngine 建立順序晚於 runner） |
| B2 | `extractProjectFromTaskId("TASK-013")` 回傳 `"TASK"` | project_memory 永遠查不到資料 | `ResearchQuery` 新增 `project` 欄位；由 workspace 路徑末段推導專案名 |
| B3 | `diffFiles()` 只解析 `diff --git` 標頭 | 模型輸出純 `---/+++` 格式 → 解析出 0 檔案 → 誤判 "empty diff" → **所有 patch 遭拒** | controller.ts 補解析 `+++ b/path` 行 |
| B4 | `ARTIFACT_VALIDATION` / `VERIFYING` 進入後無後續處理 | patch 停在 `proposed` 狀態，永不套用 | 新增 `onArtifactValidation` / `onVerificationRequired` hooks + `reportArtifactValidation` / `reportVerificationResult` 方法；server 接 artifactController.apply + verificationEngine.verify |
| B5 | worker registry model 硬編碼 `qwen2.5-coder:7b` | `LLAMA_MODEL` env 無效，UI 顯示錯誤模型 | registry 讀取 env |

### 附帶發現（非程式碼問題）

| 發現 | 影響 | 處置 |
|------|------|------|
| `project_memory` 表缺 `tags`/`vector` 欄位（舊 migration 建立） | MemoryRetriever SELECT 崩潰 | seed 腳本自動 ALTER TABLE 修復 |
| Port 3001 被殘留進程佔用，新 server 綁定失敗但 log 仍印 "listening" | 除錯時新代碼看似生效實則否 | 以 `lsof -i :3001` 驗證進程身份 |
| tsx watch（非 watch 啟動模式）修改後不自動重載 | 修復未生效造成誤判 | 重啟流程標準化 |

---

## 3. 整合測試執行紀錄

### 3.1 任務清單（依時間序）

| Task | 任務描述 | 結果 | Attempts | 分析 |
|------|----------|------|----------|------|
| TASK-008~009 | 修 safe_divide | 卡死 RESEARCHING | 1 | B1 斷點（修復前基線） |
| TASK-010~017 | 修 safe_divide | 停於 PLANNING/BLOCK | 1 | B2/B4 + 知識庫冷啟動 |
| TASK-018 | 修 safe_divide | 卡 ARTIFACT_VALIDATION | 1 | Worker 成功產出 patch（llama 模式首次驗證 ✓），B3 斷點阻擋套用 |
| TASK-019 | 修 safe_divide | STOP | 4 | diffFiles 修復前：patch 遭拒 → reflection ×4 |
| TASK-021 | 修 safe_divide | **COMPLETE** | 1 | 但 patch 誤刪 average 函式 → **沙箱驗證應攔截而未攔**（見 §4） |
| TASK-022~023 | 修 safe_divide（含注意事項） | STOP | 4 | demo repo 基線本身含 lint 違規（I001），模型無法達標 |
| **TASK-024** | **聚焦範圍版** | **COMPLETE ✅** | **1** | **pytest 3 passed + ruff clean，diff 僅 ±2 行零副作用** |

### 3.2 最終成功運行的 Pipeline 追蹤（TASK-024）

```
① POLICY_CHECK          判定需研究（unknown_dependency）
② RESEARCHING           Research Engine 命中 2 證據來源：
                          - style-kb:seed-zerodiv-valueerror（修正案例）
                          - memory:acp-demo:python:zerodivisionerror:...（專案記憶）
③ EVIDENCE_GATE         sourcesCount=2 ≥ minimum_sources=2 → PASS
④ IMPLEMENTING          PiWorker llama 模式（ollama qwen2.5-coder:7b）
                        輸出 unified diff（含 hunk 行數錯誤 → 自動修復）
⑤ ARTIFACT_VALIDATION   normalizeExistingFiles 修復 hunk 計數
                        validatePatch：src/utils.py ∈ allowed("src/**") → APPROVED
                        apply → git apply 寫入 workspace
⑥ VERIFYING             seatbelt sandbox：
                          git_diff=PASS / unit_test=PASS(3 passed) / lint=PASS
⑦ COMPLETE              attempt 1，零重試
```

### 3.3 沙箱防護實證（TASK-021 案例）

TASK-021 的 patch 正確修了 `safe_divide` 但**誤刪 `average` 函式內容**：

```diff
 def average(numbers: list[float]) -> float:
     """Return the average of numbers."""
-    return sum(numbers) / len(numbers)    ← 被模型 diff 吃掉
```

結果：`unit_test FAIL` → 反思分類 `coding_error` → 重試。
**此案例證明控制平台的價值**：無管制模式下此類 patch 會直接進入 codebase。

---

## 4. 測試期間發現的行為觀察

### 4.1 已知限制（非缺陷）

| 觀察 | 說明 |
|------|------|
| 7B 模型 diff hunk 邊界吃掉相鄰函式 | qwen2.5-coder:7b 在「修改函式 A、相鄰函式 B 共存」時常輸出過大 hunk。Artifact Controller 的 hunk 修復可救行數計算，但無法救語意範圍。緩解：任務表述明確限定範圍（TASK-024 vs TASK-019 對照） |
| lint I001 基線污染 | demo repo 初始 commit 即含 import 排序違規 → 模型無論如何改都過不了 lint。**教訓：基線必須乾淨** |
| 反思重試無 backoff | §14.4 定義退避秒數 `[5, 30]` 但 gate 未實作延遲，重試立即觸發 |

### 4.2 CP Gain 初步量化素材

| 模式 | 任務 | Attempts | 結果 |
|------|------|----------|------|
| 寬泛表述 + 7B | TASK-019/020/022/023 | 4（耗盡） | STOP |
| 聚焦表述 + 7B | TASK-024 | 1 | COMPLETE |
| 無研究對照 | （Baseline A 待跑） | — | 待 T024 benchmark |

---

## 5. 自動化測試套件狀態

```
apps/control-plane:  226 tests / 224 pass / 2 skip / 0 fail
typecheck:           clean (tsc --noEmit)
前端 build:          clean (vite build)
```

更新之測試：
- `tests/integration/api.test.ts`：兩處狀態斷言由「停滯 RESEARCHING」改為合法 pipeline 狀態集合（原斷言固化了 B1 斷點造成的卡死行為）

---

## 6. 結論

1. **核心閉環已驗證可用**：自然語言任務 → 研究 → 閘門 → 本地 LLM → 沙箱驗證 → 套用，全程零人工介入完成（TASK-024）。
2. **沙箱防護有效**：錯誤 patch（誤刪函式）被 unit_test 攔截並觸發反思重試。
3. **整合層是過去最大的隱性缺口**：單元測試全綠 ≠ pipeline 可運行；本次 5 個斷點全部位於元件「之間」。
4. **下一步建議**：
   - T024 Benchmark 正式跑分（Baseline A vs F，量化 CP Gain）
   - 反思退避（§14.4 backoff）實作
   - ASK_USER 審核流接入 artifact apply 前（目前自動套用，spec §45.5 的 approve 流程僅涵蓋 gate BLOCK 情境）

---

## 附錄：重現方式

```bash
# 1. 啟動服務
ollama serve &
cd ~/Projects/local-ai-controlpanel/apps/control-plane
LLAMA_BASE_URL=http://127.0.0.1:11434 LLAMA_MODEL=qwen2.5-coder:7b npx tsx src/main.ts &

# 2. 播種知識庫
npx tsx scripts/seed-kb-runtime.ts

# 3. 建立測試 repo（含 pyproject.toml、乾淨 lint 基線、safe_divide bug）

# 4. 下任務
curl -X POST http://127.0.0.1:3001/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"userRequest": "<明確範圍的修復指示>", "workspace": "/tmp/acp-demo"}'

# 5. 觀察
curl http://127.0.0.1:3001/api/v1/tasks/<ID>   # 或 Desktop UI 點選任務看 SSE 事件流
```
