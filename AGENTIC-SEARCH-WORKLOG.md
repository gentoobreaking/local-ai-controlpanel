# 工作紀錄：Agentic 研究迴圈與 pi Agent 整合（2026-08-26）

> **範圍**：專案目的重新對焦 → 落差分析 → Web Research Retriever → Agentic 搜尋迴圈 → 官方 pi Agent spike 驗證 → PiAgentWorker 正式整合
> **對應 Commits**：`8fd7d5b`（web retriever）、`bef172e`（agentic 骨架+spike）、`dd20036`（README）、`daf4aec`（PiAgentWorker）
> **前置報告**：[E2E-INTEGRATION-TEST-REPORT.md](./E2E-INTEGRATION-TEST-REPORT.md)（pipeline 整合層修復）

---

## 1. 專案目的重新對焦

本輪工作起點是對專案核心目的的釐清，它修正了先前的兩個設計假設：

| 先前假設 | 修正後的定位 |
|----------|-------------|
| ASK_USER/approve 是主要審核機制 | 僅保留給「知識缺口無解」的降級情境；**AI 應自主查證後行動** |
| 研究引擎查本地記憶體/案例庫即足夠 | 核心前提是「**靠網路資訊提高小模型能力**」——必須有真正的外部檢索 |

### 目標的三個層次

1. **能力層**：小模型（7B–9B）在自身知識不足時，藉由網路資訊（官方文件、GitHub、套件說明）
   提升寫程式與除錯能力——如同一個不熟程式的人靠查資料完成任務。
2. **結構層**：「先查再寫」不是對模型的行為期望（agentic 不保證會查），而是 pipeline 的
   固定階段與外部約束——查詢上限、退化偵測、收斂條件全部由 Control Plane 結構強制。
3. **觀測層**：前端用於**觀察** AI 在每個階段的資訊收集、判斷、思考決策過程，
   不是執行審查工具。

---

## 2. 落差分析（對照修正後的目標）

| 能力需求 | 本輪前狀態 | 行動 |
|----------|-----------|------|
| 外部網路檢索 | ❌ 只有本地 memory/style-KB + 金融類 MCP | 新建 web-retriever（§3） |
| 迭代式查詢迴圈 | ❌ 單發生成 | SEARCHING 狀態 + pi Agent ReAct（§4/§5） |
| 過程可觀測 | ⚠️ 只顯示階段名稱 | search/tool_execution SSE 事件（§5.3） |
| 自主性 vs 審批 | ASK_USER 定位混淆 | 重定位為降級情境專用；主路徑自主 |

---

## 3. Web Research Retriever（多來源檢索）

### 3.1 來源矩陣

| 來源 | 技術 | 觸發條件 | 產出 |
|------|------|----------|------|
| PyPI JSON API | 純 fetch（查詢抽套件名比對白名單） | 查詢含已知套件名 | 套件官方描述 + 文檔 URL |
| GitHub MCP | `ghcr.io/github/github-mcp-server`（docker/binary/remote） | `CP_MCP_GITHUB_ENABLED=1` + token | repo search + README |
| Scrapling MCP | `scrapling-mcp` stdio（pip install "scrapling[ai]"） | `CP_MCP_SCRAPLING_ENABLED=1` | 網頁 → Markdown（含 prompt injection 防護） |
| project_memory | SQLite（既有 T032） | 自動 | 專案歷史修正模式 |
| style_kb | SQLite（既有 T029） | 自動 | 錯誤→修正案例 |

### 3.2 架構要點

- **統一介面**：`createWebRetriever({ config, githubToken })` → `.retrieve(query, language)`
- **延遲連線**：McpClient 首次 retrieve 時才 connect；失敗靜默降級（其他來源照常）
- **best-effort**：各來源 `Promise.allSettled` 平行執行，單一失敗不阻塞
- **證據格式**：統一為 `{ type: "external", metadata: { origin, url } }`

### 3.3 實測

PyPI 路徑 live 驗證通過：查詢含「requests」→ 回傳套件描述（confidence 0.75）。

---

## 4. Agentic 搜尋迴圈（骨架先行）

在 pi Agent 正式整合前，先於 runner 層建立迴圈骨架與狀態機基礎：

```
WORKER_SELECTION
    ↓
SEARCHING（新增 TaskStatus + 狀態機轉移）
    Thought ：PiWorker.evaluateSufficiency() → {sufficient, missing, queries}
    Action  ：queries → web-retriever 執行
    Observation：結果落庫（recordEvidence）→ 自動流入 worker contract
    │  護欄：重複查詢偵測 / 連續空轉 ≥2 輪強制收斂 / maxRounds 硬上限
    ↓
IMPLEMENTING
```

配套：
- `StageEvent` 新增 `search` 型別（round/maxRounds/sufficient/missing/queries/foundCount/sources）
- config：`CP_AGENTIC_SEARCH`（預設開）、`CP_MAX_SEARCH_ROUNDS`（預設 10）

---

## 5. 官方 pi Agent Spike 驗證

### 5.1 為什麼走官方 pi Agent

自製 worker 的 agentic 行為無法保證「模型一定會查」——解法有二：
runtime 引用審計（事後抓違規）或 **採用官方 pi agent 的原生 hooks（事前結構保證）**。
pi 的設計正是為此而生：

| 我們的需求 | pi 原生機制 |
|-----------|------------|
| 迭代式 ReAct | `runAgentLoop` 內建 |
| 強制先查後寫 | `beforeToolCall` 攔截 + prompt 強制 |
| 輪次上限收斂 | `shouldStopAfterTurn` |
| 缺口提示注入 | `prepareNextTurn` |
| 全程觀測 | `subscribe(AgentEvent)` → SSE 橋接 |

### 5.2 Spike 結果（`apps/control-plane/pi-agent-spike.mts`）

**環境**：pi Agent 0.84.3 + ollama qwen2.5-coder:7b + 自訂 web_search tool

| # | 驗證項 | 結果 |
|---|--------|------|
| 1 | Agent + ollama 基本生成 | ✅ |
| 2 | 自訂 AgentTool 被模型呼叫 | ✅ |
| 3 | 多輪 ReAct 迴圈（受控 harness） | ✅ 10 輮上限正常 |
| 4 | 觀察結果影響模型行為 | ✅ Round 2 自動調整查詢關鍵字 |
| 5 | 文字型 tool call 適配 | ✅ 見 §5.3 發現 #2 |
| 6 | 退化偵測強制收斂 | ✅ 重複查詢即收斂（round 2 給出最終答案） |

### 5.3 關鍵技術發現（除錯血淚）

| # | 發現 | 症狀 | 解法 |
|---|------|------|------|
| 1 | **必須提供 dummy API key**（`getApiKey: () => "ollama"`） | 空回應、usage 全 0、無錯誤事件——極難排查 | 一行修復，但需知道要找它 |
| 2 | **ollama 對 qwen2.5-coder 不回 native tool_calls** | 模型以純文字 JSON 輸出 tool call → pi 視為最終答案直接結束 | 適配層解析文字型 tool call → 執行 → 結果回灌繼續迴圈。此方案讓任何小模型都能跑 agentic |
| 3 | AgentMessage 格式：`content` 陣列 + `timestamp` 必填 | `content is not iterable` | 參照 types.ts |
| 4 | 具體 API 在 `/compat` 子路徑 | `streamSimple` 主入口不存在 | `import { streamOpenAICompletions } from "@earendil-works/pi-ai/compat"` |
| 5 | compat 旗標照官方 llama provider 抄 | 潛在相容性地雷 | supportsStore/DeveloperRole/ReasoningEffort=false 等 |

---

## 6. 正式整合（PiAgentWorker）

### 6.1 設計

```
CodingWorker 介面不變（ACP 其他層零改動）
    └── PiAgentWorker implements CodingWorker
          ├── AgentTool: web_search → retrieveWebEvidence（Control Plane 側檢索）
          ├── AgentTool: read_file → workspace 限定讀檔（拒絕 .git/.env/secrets/node_modules）
          ├── beforeToolCall → 觀測橋接（onEvent → TaskBus → SSE）
          ├── shouldStopAfterTurn → maxSearchRounds 收斂
          └── 產出 unified diff → 交回既有 Artifact Controller 驗證套用
```

### 6.2 安全邊界（不變項）

| 邊界 | 實作 |
|------|------|
| 模型零上網 | web_search 由 Control Plane 注入的 retriever 執行；沙箱 deny network |
| 讀檔限定 | `isWorkspacePathSafe()` 白名單外一律拒絕 |
| 變更管控 | patch 仍經 Artifact 政策白名單 + git dry-run 才落地 |
| injection 防護 | Scrapling 內建隱藏元素淨化；證據以文字注入非指令 |

### 6.3 切換機制

```bash
CP_AGENTIC_SEARCH=1   # PiAgentWorker（ReAct 迴圈）
CP_AGENTIC_SEARCH=0   # 單發 PiWorker + runner 層搜尋迴圈
```

server 以延遲綁定注入 webSearch（retriever 建立順序晚於 registry）；
onEvent 直接橋接 TaskBus → 前端自動獲得新事件。

---

## 7. 前端觀測

TaskStream 新增渲染：

```
🔍 search r1/10 → requests upload file timeout      ← 模型決定的查詢
🔧 web_search()                                      ← 工具執行
🔍 found 3 (pypi, github)                            ← 命中來源
✓ sufficient                                         ← 收斂判定
```

配合既有的階段時間軸（POLICY_CHECK → ... → COMPLETE），使用者可完整觀察
「小 AI 查了什麼、學到什麼、怎麼用它」的每一個決策瞬間。

---

## 8. 測試與驗證狀態

```
typecheck:        clean
vite build:       OK
control-plane:    226 tests / 224 pass / 2 skip / 0 fail
E2E 閉環（單發模式）：TASK-024 attempt 1 即 COMPLETE（pytest 3 passed + ruff clean）
Agentic 模式 E2E：  基礎設施就緒；TASK-025 顯示 attempt 1 即達 VERIFYING
                    （web 證據生效），收斂品質待 7B 模型迭代改善
```

---

## 9. 下一步

| 項目 | 說明 |
|------|------|
| **T024 Benchmark 正式跑分** | Baseline A（無研究）vs F（完整 CP），N≥5，量化 CP Gain |
| **L1/L2 任務集建置** | 「7B 自己不會、查了文件就會」的分級題庫——驗證核心命題的題材 |
| **evidence_utilization metric** | patch 中使用的 API 是否存在於已取得證據中——區分「檢索不足」vs「理解不足」 |
| **PiAgentWorker 迭代** | beforeToolCall 強制首查、prepareNextTurn 注入 missing 清單、引用覆蓋率 |
| **前端搜尋迭代展開 UI** | 折疊式顯示完整 markdown 證據內容 |
| **ASK_USER 重定位** | 僅保留給高風險知識缺口降級；主路徑全自主 |

---

## 附錄：啟用 Agentic 模式的完整設定

```bash
# .env
LLAMA_BASE_URL=http://127.0.0.1:11434
LLAMA_MODEL=qwen2.5-coder:7b
GITHUB_TOKEN=$(gh auth token)
CP_MCP_GITHUB_ENABLED=1
CP_MCP_SCRAPLING_ENABLED=1     # 需先 pip install "scrapling[ai]" && scrapling install
CP_AGENTIC_SEARCH=1
CP_MAX_SEARCH_ROUNDS=10

# 啟動
pnpm cp:dev && pnpm tauri dev
```
