# Agent Control Plane

## 專案簡介

**Agent Control Plane (ACP)** 是一個幫助 AI 代理「乖一點」的工具。傳統的 AI 寫程式往往直接動手，不查攻略，容易出錯或產生有害內容。

ACP 的核心思想是：**在 AI 寫程式前，先強制進行知識驗證和政策審查**，就像人類工程師在動手前會先看文件、確認 API 怎麼用一樣。

## 我們解決什麼問題？

| 問題 | ACP 如何幫忙 |
|------|-------------|
| AI 寫程式「瞎指揮」，不確定 API 該怎麼用 | **Evidence Gate**：寫程式前先檢查證據，確認有足夠資訊再動手 |
| 擔心 AI 生成違規或有害程式碼 | **Policy Engine**：依據預設規則（YAML）檢查，拒絕可疑行為 |
| 想用本地 AI 模型（7B/9B），但擔心不夠強 | **Cloud Hybrid**：需要時自動諮詢雲端模型輔助 |
| 恐怕程式碼變更會破壞項目 | **Sandbox**：變更前先在封閉環境測試，出問題自動回滾 |
| 想把 AI 當工具用，但怕失控 | **acpctl CLI**：一個統一的指令集，啟動/停止/測試一切盡在掌控 |

## 關鍵流程（圖示版）

```text
使用者請求
   ↓
[任務管理器] → [研究引擎] → [政策引擎] → [證據閘門] → [工件控制器]
   ↓                     │                      ↓
[Pi  Worker]       [雲端提供者]    [沙箱]          [應用/回滾]
   ↓                     │
[工人註冊]           [混合 escalation]
```

## 快速開始

```bash
# 1. 複製環境變數設定檔
cp .env.example .env

# 2. 啟動 Control Plane（自動檢查本地模型）
pnpm cp:dev

# 3. 開啟桌面 UI（需要 Control Plane 運行中）
pnpm tauri dev
```
| **Artifact Controller** | Diff 正規化 + 驗證/應用/回滾 | 標準化程式碼變更的介面與流程 |
| **Policy Engine** | YAML + Zod + Knowledge Policy | 可程式化的行為約束與檢查 |
| **Cloud Hybrid** | Reviewer/Planner/Executor/Cloud Only 四種模式 | 在本地能力不足時安全升級至雲端 |
| **Sandbox Execution** | bwrap/seatbelt 預設封鎖模式 | 隔離執行環境，防止惡意或誤操作 |
| **Pi Worker** | llama.cpp / ollama 串接 | 靈活切換本地/雲端推理引擎 |
| **acpctl CLI** | 統一控制腳本 | 一站式啟動/測試/部署 |

## 目標使用者

- **AI 研究者**：探索代理行為可釐善性與政策實驗
- **軟體開發團隊**：透過 AI 自動化重複性程式碼任務，同時保持審查把關
- **安全/合規角色**：確保 AI 操作符合組織政策與風險標準
- **項目負責者**：追蹤 AI 代理對項目基碼的實際影響

## 專案路徑

- **程式碼根目錄**：`~/Projects/local-ai-controlpanel`（monorepo）
- **規格文檔**：`~/tasks/local-ai-controlpanel/agent-control-plane-spec-v0.5.md`（唯一權威版本）
- **任務細則**：`~/tasks/local-ai-controlpanel/tasks/`（逐項任務書）

---

## 📦 Quick Start

首次使用請依照下列步驟操作：

```bash
# 1. 複製環境變數範本
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

專案包含下列核心能力（已完成實作與單元測試）：

| 功能 | 說明 | 相關任務 |
|------|------|----------|
| **Evidence Gate** | 兩階段評估 + 降級政策 + 卡死防護 - 總分≥0.7、最少證據數、單一分數閾值、高風險阻擋 | T039 |
| **Artifact Controller** | Diff 正規化（canonicalizeDiff） + 驗證/應用/回滾 | T040 |
| **MCP Integration** | 外部 MCP Server 自動啟動與 stdio JSON-RPC Proxy（tw-quant/yfinance/finmind） | T041 |
| **Cloud Hybrid** | Reviewer/Planner/Executor/Cloud Only 四種 escalation 模式 | T035 |
| **Sandbox Execution** | bwrap（Linux）/seatbelt（macOS）預設封鎖模式 | T013–T016 |
| **Pi Worker** | llama.cpp / ollama 串接 + 模型成本控制 | T021–T032 |
| **CLI (acpctl)** | 統一控制腳本：啟動/停止/基準測試/雲端檢查 | T033 |
| **Tauri Desktop UI** | TopBar / TaskList / TaskStream / InputBar / Palette 佈局 | T001–T004 |

---

## 👤 User Manual

### 安裝

```bash
# 複製環境變數
cp .env.example .env

# 編輯 .env 設定：
# - LLAMA_BASE_URL: 本地模型端點（預設 http://127.0.0.1:8080）
# - CP_ALLOW_CLOUD: 是否允許雲端 escalation（0/1）
# - CP_CLOUD_PROVIDER: anthropic | openai | gemini
# - Cloud API Keys（如需使用雲端模型）
```

### 基本工作流程

1. **建立任務**：`acp task create "..."` 或透過 Desktop UI
2. **執行研究**：引擎檢索相關知識、生成 prompt
3. **證據評估**：Evidence Gate 自動判斷是否通過（≥0.7 閾值）
4. **工件處理**：Artifact Controller 正規化 diff、驗證變更
5. **打包部署**：`./scripts/build-macos.sh --install` 製作 .app/.dmg

### 模型配置

- **本地模型**：確保 llama-server 或 ollama 正運行
- **雲端模型**：設定 `CP_ALLOW_CLOUD=1` 並填寫 API Keys
- **混合模式**：使用 `CP_PHASE=9` 開啟 Phase 9+ 功能

### 常用指令

```bash
# 啟動/停止 Control Plane
./scripts/acpctl.sh cp:start
./scripts/acpctl.sh cp:stop

# 執行基準測試
./scripts/acpctl.sh baseline:run --baseline H --mode llama --max-tasks 5

# 雲端可用性檢查
./scripts/acpctl.sh cloud:check

# 完整測試與 typecheck
./scripts/acpctl.sh test
```

---

## 🛠️ 開發指南

### 環境需求

- Node.js >= 18
- Rust + Tauri 2
- Python 3.11（研究引擎）
- llama-server / ollama（本地模型）

### 專案結構

```text
local-ai-controlpanel/
├── src/                  # Tauri Desktop UI（React + TS）
├── src-tauri/            # Rust 外殼
├── apps/
│   ├── control-plane/    # Fastify + Zod API（§45.5）
│   └── cli/              # acp CLI
├── policies/             # YAML policy 配置
├── schemas/              # JSON Schema
├── packages/             # 核心封裝（core/task/policy/state）
├── benchmark/            # 執行測試與報告
├── tests/                # 單元/整合/End-to-End 測試
└── scripts/              # 自動化腳本
```

### 開發指令

```bash
pnpm install                      # 安裝相依項目

# Control Plane
pnpm cp:dev                       # 啟動 Fastify → 127.0.0.1:3001
pnpm cp:build                     # TypeScript 编译
pnpm cp:test                      # 單元測試（node:test + tsx）

# 前端
pnpm dev                          # Vite http://localhost:1420
pnpm tauri dev                    # 桌面 UI（需 CP 於 127.0.0.1:3001）
pnpm tauri build                  # 打包 .app/.dmg

# CLI
pnpm acp -- <cmd>                # 執行 acp 指令

# 單一方式
pnpm typecheck                    # 全 repo strict typecheck
```

### 單元測試

- **Evidence Gate**：15 tests pass
- **Artifact Controller (canonicalizeDiff)**：7 tests pass
- **總計**：224 pass / 226 total（2 skip）

### Typecheck

```bash
pnpm typecheck                    # 執行全域 strict typecheck
```

---

## 📦 macOS 打包（.app / .dmg）

一鍵腳本（推薦）：

```bash
./scripts/build-macos.sh              # 只打包（cp:bundle + tauri build）
./scripts/build-macos.sh --install    # 打包 + 安裝到 /Applications + post-install smoke test
./scripts/build-macos.sh --skip-bundle # 跳過 CP 打包（只 build 前端+tauri）
./scripts/build-macos.sh --clean      # 清 target 完整重編譯
ACp_VERSION=0.6.0 ./scripts/build-macos.sh  # 覆寫版本號
```

`--install` 含 post-install smoke test（驗證 CORS header 與 SSE 端點）。

**手動部署 workround**：
若 `--install` 失敗，可使用 `rsync` 將 `Agent Control Plane.app` 手動複製到 `/Applications/`。

**注意事項**：

- 請使用 `./node_modules/.bin/tauri build`（非 `pnpm tauri build`），避免 pnpm 自動 prune devDeps 導致 `tauri: not found`
- 打包時若 `BUILD_ENV=production`，pnpm 會跳過 devDeps → 前置 `BUILD_ENV=development NODE_ENV=development`
- Tauri 2 release build 會將前端 assets 內嵌進 Rust binary，Resources 裡無 `index.html` 為正常現象
- **CORS 雙路徑陷阱**：SSE 端點 (`/api/v1/tasks/:id/events`) 繞過 `fastify/cors` plugin，必須手動補 `Access-Control-Allow-Origin`；出現 reconnecting 時先 `curl` 檢查 header

---

## 🐳 Pi Worker 模型接入

Pi Worker 透過 OpenAI-compatible endpoint 串接本地推理引擎：

- **預設**：llama.cpp（:8080）
- **切換**：ollama（:11434）

```bash
# 啟動 llama-server
llama-server -m ~/models/qwen2.5-coder-7b.Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 -c 8192 --n-gpu-layers 99

# Control Plane 零配置（baseUrl 預設 http://127.0.0.1:8080）
pnpm cp:dev

# 切換 ollama
LLAMA_BASE_URL=http://127.0.0.1:11434 pnpm cp:dev
```

---

## ☁️ Cloud Provider / Hybrid Execution（T035, Phase 9+）

### 四種 Escalation Modes

| Mode | Key | 流程 | 啟用條件 |
|------|-----|------|----------|
| **Reviewer First** | H | Local 失敗 → Cloud Reviewer 審查 patch → Local 重做 | Local 失敗 ≥ 1 次 |
| **Planner First** | I | Complex task → Cloud Planner 產生計畫 → Local 實作 | 高複雜度 task |
| **Executor First** | J | Critical path → Cloud Executor 產出 patch → Local 驗證 | 高風險 + 多次失敗 |
| **Cloud Only** | K | Full Cloud（Claude/GPT，無 Control Plane） | Phase 11+ 高風險 |

### 環境變數配置

```bash
CP_PHASE=9                              # Phase 設定（1-11，預設 1）
CP_ALLOW_CLOUD=1                        # 是否允許 Cloud（Phase 9+ 才生效）
CP_CLOUD_PROVIDER=anthropic           # anthropic | openai | gemini
ANTHROPIC_API_KEY=sk-ant-...          # Cloud API Keys
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
CP_MAX_DAILY_COST_USD=50.0              # 每日成本上限（USD）
CP_MAX_TOKENS_PER_TASK=100000           # 單任務 token 上限
```

---

## 🔒 Security

- Control Plane 僅 bind `127.0.0.1`（§45.3）；Phase 1–5 `allow_cloud: false`（§24）
- WebView capabilities：`core:default` + `opener:allow-open-url`（僅 http/https），無 filesystem/shell/secrets
- Sandbox 模式：bwrap（Linux）/seatbelt（macOS）為預設；docker 為 fallback

---

## 📜 License

本專案採用 **Apache License 2.0** 授權。

- 完整授權條款見 [`LICENSE`](LICENSE)（專案根目錄）
- Apache-2.0 官方條款：<https://www.apache.org/licenses/LICENSE-2.0>
- 版權與貢獻者資訊以 LICENSE 檔案為準

> 本專案為研究/模擬用途，授權條款不構成任何投資建議或保證；
> 使用/修改/再散佈前請詳閱 LICENSE 全文。

---

## 📄 Change Log

詳細任務進度與變更記錄請參閱 `CHANG_LOG.md`。

> 本專案遵循半時間軸變更日誌原則，主要里程碑會於此錄製。若需追蹤細部開發提交，請參閱 git log 或 `~/tasks/local-ai-controlpanel/tasks/`。