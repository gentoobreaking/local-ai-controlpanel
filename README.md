# Agent Control Plane

## 專案簡介

**Agent Control Plane (ACP)** 是一個讓小型本地 AI 模型「自習」的代理控制平台。

傳統的 AI 寫程式往往直接動手，不查攻略，容易出錯或產生幻覺內容。
小型模型（7B–9B）受制於參數量，這個問題更嚴重——但小模型仍具備基本判斷能力，
就像一個不熟程式設計的人，依然能夠靠網路上的資訊寫出程式並除錯。

ACP 的核心思想：
**在 AI 寫程式前，先強制進行知識檢索與政策審查；用外部知識彌補小模型的能力缺口，
並將 AI 在每個階段的資訊收集、判斷、思考決策過程完整呈現給使用者觀察。**

### 三個核心設計原則

1. **結構性保證查證**——「先查再寫」不是行為期望，而是 pipeline 的固定階段；
   查詢次數上限、退化偵測、引用一致性全部由 Control Plane 結構強制執行。
2. **模型不上網，平台代查**——Worker 沙箱內 `deny network`；
   檢索由 Control Plane 側的 Retriever 執行後，以淨化文字注入 prompt。
3. **過程完全可觀測**——每個階段的證據內容、閘門判定理由、搜尋迭代過程
   都透過 SSE 事件流送到前端，供觀察而非審批。

---

## 我們解決什麼問題？

| 問題 | ACP 如何幫忙 |
|------|-------------|
| 小模型 API 知識不足，參數用法憑幻覺 | **Web Research**：自動查 PyPI / GitHub / 官方文件，證據注入 prompt |
| 不知道自己不知道什麼 | **Evidence Gate**：量化評估證據充分度，不足時觸發 Agentic 搜尋迴圈 |
| AI 生成的變更破壞專案 | **Sandbox Verification**：seatbelt/bwrap 內跑 pytest/ruff，壞 patch 攔截在落地前 |
| 錯了之後盲目重試 | **Reflection**：失敗分類（coding_error / knowledge_error），knowledge_error 觸發新一輪有目的的搜尋 |
| 想用本地模型但怕失控 | **acpctl CLI + Desktop UI**：統一控制與全程觀測 |

---

## 關鍵流程

```text
使用者任務（自然語言）
   ↓
┌─────────────────────── Control Plane ────────────────────────┐
│                                                              │
│  POLICY_CHECK ──── 政策引擎判定是否需要研究                    │
│      ↓                                                       │
│  RESEARCHING ──── 研究引擎檢索（多來源平行）：                  │
│      │             ├─ project_memory   專案歷史修正模式        │
│      │             ├─ style_kb         錯誤→修正案例庫         │
│      │             ├─ PyPI JSON API    套件官方描述            │
│      │             ├─ GitHub MCP       repo search + README   │
│      │             └─ Scrapling MCP    官方文件站 → Markdown   │
│      ↓                                                       │
│  EVIDENCE_VALIDATION ─ 證據閘門（兩階段評估）                   │
│      │  sourcesCount ≥ minimum_sources？                      │
│      ├─ PASS ──────────────────────────→ WORKER_SELECTION     │
│      ├─ INSUFFICIENT ── AGENTIC SEARCH（見下方迴圈）           │
│      └─ BLOCK ───────────────────────── → ASK_USER / STOP     │
│                                                              │
│  ★ AGENTIC SEARCH 迴圈（CP_MAX_SEARCH_ROUNDS，預設 10）        │
│      Thought   ：模型自評「我還缺什麼？」                       │
│                  輸出 {sufficient, missing, queries}           │
│      Action    ：queries → Retriever 執行（沙箱外，有網路）     │
│      Observation：結果回灌 context + 證據落庫                   │
│      │  退化偵測：重複查詢／連續空轉 → 強制收斂                  │
│      └─ 迴圈直到 sufficient 或達上限                            │
│                                                              │
│  IMPLEMENTING ─── Pi Worker（ollama / llama.cpp 本地推理）     │
│      │             證據打包進 PiContract → 生成 patch          │
│      ↓                                                       │
│  ARTIFACT_VALIDATION ─ hunk 修復 + 政策白名單 + git apply      │
│      ↓                                                       │
│  VERIFYING ────── seatbelt / bwrap 沙箱（deny network）：      │
│      │             git_diff + unit_test(pytest) + lint(ruff)  │
│      ├─ 全 PASS → COMPLETE                                    │
│      └─ FAIL → REFLECTION 分類失敗                             │
│              ├─ coding_error    → retry（帶失敗回饋）          │
│              └─ knowledge_error → 新一輪有目的的搜尋            │
└──────────────────────────────────────────────────────────────┘
```

> **安全邊界不變**：模型本身從頭到尾沒有上網能力——
> 查資料的能力長在 Control Plane 的 Retriever 層，模型只消費淨化後的證據文字。

---

## 📦 Quick Start

```bash
# 1. 複製環境變數範本並編輯
cp .env.example .env

# 2. 啟動 Control Plane（本地 llama.cpp 或 ollama）
pnpm cp:dev

# 3. 啟動桌面 UI（需要 CP 運行在 127.0.0.1:3001）
pnpm tauri dev
```

或使用統一控制腳本：

```bash
./scripts/acpctl.sh cp:start          # 啟動 Control Plane（自動檢查 llama.cpp、等待 health）
./scripts/acpctl.sh help              # 查看所有可用指令
```

---

## 🔧 Core Features

| 功能 | 說明 | 相關任務 |
|------|------|----------|
| **Web Research Retriever** | 多來源證據檢索：PyPI JSON API / GitHub MCP / Scrapling MCP / 本地記憶體 | E2E 2026-08 |
| **Agentic Search Loop** | 模型自評證據缺口的迭代查詢迴圈（退化偵測 + 硬上限） | E2E 2026-08 |
| **Evidence Gate** | 兩階段評估 + 降級政策 + 卡死防護 | T039 |
| **Artifact Controller** | Diff 正規化（hunk 修復）+ 政策白名單 + 驗證/應用/回滾 | T040 |
| **MCP Integration** | 外部 MCP Server 自動啟動與 stdio JSON-RPC Proxy | T041 |
| **Sandbox Execution** | bwrap（Linux）/ seatbelt（macOS）預設封鎖模式 | T013–T016 |
| **Pi Worker** | ollama / llama.cpp OpenAI-compatible 串接 | T021–T032 |
| **CLI (acpctl)** | 統一控制腳本 | T033 |
| **Tauri Desktop UI** | 任務列表 / SSE 事件流（含搜尋迭代觀測）/ 縮放與字體調整 | T001–T004 |
| **Cloud Hybrid** | Reviewer/Planner/Executor/Cloud Only 四種 escalation 模式 | T035 |

---

## 🔍 研究來源設定

研究引擎的多來源檢索，各來源 best-effort（單一失敗不阻塞 pipeline）：

| 來源 | 啟用方式 | 用途 |
|------|----------|------|
| project_memory | 自動（隨任務累積） | 專案內成功修正模式 |
| style_kb | `npx tsx scripts/seed-kb-runtime.ts` 播種 | 錯誤→修正案例（跨專案） |
| PyPI | 自動（偵測查詢中的套件名） | Python 套件官方描述 |
| GitHub MCP | `GITHUB_TOKEN` + `CP_MCP_GITHUB_ENABLED=1` | repo search、README |
| Scrapling MCP | `pip install "scrapling[ai]" && scrapling install` + `CP_MCP_SCRAPLING_ENABLED=1` | 官方文件站 → Markdown |

GitHub token 可由 `gh auth token` 取得，或使用 GitHub 官方 MCP remote endpoint。

---

## 👤 User Manual

### 安裝

```bash
cp .env.example .env
# 編輯 .env：
# - LLAMA_BASE_URL: 本地模型端點（ollama: http://127.0.0.1:11434 / llama.cpp: :8080）
# - LLAMA_MODEL: 模型名稱（如 qwen2.5-coder:7b）
# - GITHUB_TOKEN: GitHub PAT（gh auth token 可取得）
# - CP_AGENTIC_SEARCH: Agentic 搜尋迴圈開關（預設開）
# - CP_MAX_SEARCH_ROUNDS: 搜尋迴圈上限（預設 10）
```

### 基本工作流程

1. **建立任務**：Desktop UI 底部輸入框，或 `curl POST /api/v1/tasks`
2. **觀察研究過程**：TaskStream 即時顯示搜尋迭代、證據命中、閘門判定
3. **驗證與反思**：沙箱自動跑 pytest/ruff，失敗自動分類重試
4. **打包部署**：`./scripts/build-macos.sh --install`

### Desktop UI 快捷鍵

| 按鍵 | 功能 |
|------|------|
| `Ctrl+K` | 命令面板（verify / research / strategy / logs / sandbox check / help） |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 視窗縮放（實際調整視窗大小） |
| `Ctrl+Shift+=` / `Ctrl+Shift+-` / `Ctrl+Shift+0` | 字體大小（介面重排，不影響視窗） |
| ↑/↓ / Esc / Enter | 輸入歷史 / 清空取消 / 送出任務 |

### 常用指令

```bash
./scripts/acpctl.sh cp:start                        # 啟動 Control Plane
./scripts/acpctl.sh baseline:run --baseline H --mode llama --max-tasks 5
./scripts/acpctl.sh cloud:check                     # 雲端可用性檢查
./scripts/acpctl.sh test                            # 完整測試與 typecheck
```

---

## 🛠️ 開發指南

### 環境需求

- Node.js >= 18
- Rust + Tauri 2
- Python 3.11 + uv（研究引擎、Scrapling）
- ollama 或 llama-server（本地模型）

### 專案結構

```text
local-ai-controlpanel/
├── src/                          # Tauri Desktop UI（React + TS）
├── src-tauri/                    # Rust 外殼（視窗控制、CP 自動啟動）
├── apps/
│   ├── control-plane/            # Fastify + Zod API（pipeline 核心）
│   │   └── src/
│   │       ├── research/         # 研究引擎 + web-retriever（多來源檢索）
│   │       ├── worker/           # Pi Worker（ollama/llama.cpp 串接）
│   │       ├── policy/           # 政策引擎 + Cloud Executor
│   │       ├── artifact/         # Diff 正規化 + 套用/回滾
│   │       └── evidence/         # Evidence Model + Gate
│   └── cli/                      # acp CLI
├── policies/                     # YAML policy 配置
├── schemas/                      # JSON Schema
├── benchmark/                    # Baseline A–F 跑分框架
└── scripts/                      # 自動化腳本（seed-kb-runtime 等）
```

### 測試狀態

```
control-plane: 226 tests / 224 pass / 2 skip / 0 fail
typecheck:     clean
E2E 閉環:      已驗證（詳見 E2E-INTEGRATION-TEST-REPORT.md）
```

---

## 📦 macOS 打包（.app / .dmg）

```bash
./scripts/build-macos.sh              # 只打包（cp:bundle + tauri build）
./scripts/build-macos.sh --install    # 打包 + 安裝到 /Applications + smoke test
ACp_VERSION=0.6.0 ./scripts/build-macos.sh  # 覆寫版本號
```

**注意事項**：

- 使用 `./node_modules/.bin/tauri build`（非 `pnpm tauri build`），避免 pnpm prune devDeps 導致 `tauri: not found`
- 打包時前置 `BUILD_ENV=development NODE_ENV=development`
- **CORS 雙路徑陷阱**：SSE 端點繞過 fastify/cors plugin，已手動補 `Access-Control-Allow-Origin`

---

## 🐳 Pi Worker 模型接入

Pi Worker 透過 OpenAI-compatible endpoint 串接本地推理引擎：

```bash
# 切換 ollama
LLAMA_BASE_URL=http://127.0.0.1:11434 LLAMA_MODEL=qwen2.5-coder:7b pnpm cp:dev

# 或 llama-server
llama-server -m ~/models/qwen2.5-coder-7b.Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 -c 8192 --n-gpu-layers 99
```

> **演進方向**：Worker runtime 計畫接入官方 [pi coding agent](https://github.com/earendil-works/pi)
> （`@earendil-works/pi-agent-core`），以其原生 ReAct 迴圈 + hooks
> （beforeToolCall / shouldStopAfterTurn / subscribe）取代自製單發生成。
> Spike 已驗證可行性：`apps/control-plane/pi-agent-spike.mts`。

---

## ☁️ Cloud Provider / Hybrid Execution（Phase 9+）

| Mode | Key | 流程 | 啟用條件 |
|------|-----|------|----------|
| **Reviewer First** | H | Local 失敗 → Cloud Reviewer 審查 patch → Local 重做 | Local 失敗 ≥ 1 次 |
| **Planner First** | I | Complex task → Cloud Planner 產生計畫 → Local 實作 | 高複雜度 task |
| **Executor First** | J | Critical path → Cloud Executor 產出 patch → Local 驗證 | 高風險 + 多次失敗 |
| **Cloud Only** | K | Full Cloud（Claude/GPT，無 Control Plane） | Phase 11+ 高風險 |

```bash
CP_PHASE=9
CP_ALLOW_CLOUD=1
CP_CLOUD_PROVIDER=anthropic    # anthropic | openai | gemini
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 🔒 Security

- Control Plane 僅 bind `127.0.0.1`（§45.3）；Phase 1–5 `allow_cloud: false`（§24）
- Worker 沙箱 `deny network`——模型零上網能力，檢索僅發生在 Control Plane 側
- WebView capabilities：`core:default` + `opener:allow-open-url`（僅 http/https）
- Scrapling MCP 內建 prompt injection 防護（隱藏元素淨化）
- Artifact 政策白名單：forbidden（`.git/**`, `.env`, `secrets/**`）/ readonly / allowed

---

## 📄 相關文檔

- **規格書**：`~/tasks/local-ai-controlpanel/agent-control-plane-spec-v0.5.md`
- **端到端整合測試報告**：[E2E-INTEGRATION-TEST-REPORT.md](./E2E-INTEGRATION-TEST-REPORT.md)
- **Agentic 搜尋工作紀錄**：[AGENTIC-SEARCH-WORKLOG.md](./AGENTIC-SEARCH-WORKLOG.md)
- **變更紀錄**：[CHANG_LOG.md](./CHANG_LOG.md)

---

> 本專案遵循半時間軸變更日誌原則。細部開發提交請參閱 git log。
