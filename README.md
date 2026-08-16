# Agent Control Plane

Research-driven, Evidence-gated, Policy-controlled Coding Agent Control Plane（spec v0.5）。

> **程式碼路徑**：`~/Projects/local-ai-controlpanel`（monorepo）
> **開發規格路徑**：`~/tasks/local-ai-controlpanel`（`agent-control-plane-spec-v0.5.md` 為唯一權威版本；任務書在 `tasks/`）

## 結構

```text
local-ai-controlpanel/
├── src/                    # Tauri Desktop UI（Layer 7，§45）React + TS 前端
│   ├── App.tsx             # 佈局：TopBar / TaskList / TaskStream / InputBar / Palette
│   ├── api/client.ts       # Control Plane REST + SSE client（§45.5 契約）
│   └── components/ · styles/
├── src-tauri/              # Rust 薄殼（tauri.conf.json / capabilities / commands）
├── apps/
│   ├── control-plane/      # Layer 6 Control Plane（Fastify + Zod，§45.5 API）
│   └── cli/                # acp CLI（§29）
├── packages/               # 依 §7 佔位（core/task/policy/state/...，後續逐步實作）
├── policies/               # default/coding/research/security/escalation/sandbox/kubernetes
├── schemas/                # task/evidence/policy/worker JSON Schema
├── sandbox-profiles/       # verification-default.sb（§28.1 default-deny）
├── tests/                  # unit / integration / e2e
├── benchmark/              # tasks/datasets/runners/metrics/reports/baselines
├── docs/ · docker/
└── pnpm-workspace.yaml
```

## 開發

```bash
pnpm install

pnpm cp:dev         # Control Plane（Fastify → 127.0.0.1:3001）
pnpm cp:build       # Control Plane build（tsc）
pnpm cp:test        # Control Plane unit tests（node:test + tsx）
pnpm acp -- <cmd>   # acp CLI（§29；另可用 pnpm acp task run "..." 等）
pnpm typecheck      # 全 repo strict typecheck

pnpm dev            # 前端僅 Vite http://localhost:1420
pnpm tauri dev      # Desktop UI（需 Control Plane 於 127.0.0.1:3001）
pnpm tauri build    # 打包 .app/.dmg
```

## macOS 打包（.app / .dmg）

一鍵腳本（推薦）：

```bash
./scripts/build-macos.sh              # 只打包（cp:bundle + tauri build）
./scripts/build-macos.sh --install    # 打包 + 安裝到 /Applications + post-install smoke test
./scripts/build-macos.sh --skip-bundle  # 跳過 CP 打包（只 build 前端+tauri）
./scripts/build-macos.sh --clean      # 清 target 完整重編譯
ACP_VERSION=0.6.0 ./scripts/build-macos.sh  # 覆寫版本號（預設讀 tauri.conf.json）
```

`--install` 含 post-install smoke test（驗證 `GET /api/v1/workers` 回 CORS 標頭 + SSE `/api/v1/tasks/:id/events` 也帶 `access-control-allow-origin`，**這兩個端點的 CORS header 來自不同路徑：fetch 走 cors plugin，SSE 因 `reply.hijack()` 繞過 plugin、要手動補**）；任一失敗 exit 1。

流程：`cp:bundle`（build Control Plane + 組裝 `dist-bundle/` 的 flat node_modules）→ `tauri build`（前端 build + 內嵌 binary + 產出 .app/.dmg）→（可選）`pkill` 舊進程（含 CP 子進程）→ `ditto` 覆蓋到 `/Applications`。

產物：`src-tauri/target/release/bundle/macos/Agent Control Plane.app`、`src-tauri/target/release/bundle/dmg/Agent Control Plane_<ver>_<arch>.dmg`。

### 手動部署 workaround（如果 --install 不可用）

環境自動化腳本可能擋某些寫入動作（例如 host security policy 攔 `rm -rf /Applications/...`）。備用流程：

```bash
pkill -f "Agent Control Plane.app/Contents/MacOS/acp-desktop" || true
pkill -f "control-plane/dist/main.js" || true     # 同步殺 CP 子進程，避免 attach 舊 binary
for _ in $(seq 1 10); do
  pgrep -f "Agent Control Plane" >/dev/null || break
  sleep 1
done
rsync -a --delete \
  src-tauri/target/release/bundle/macos/Agent\ Control\ Plane.app/ \
  /Applications/Agent\ Control\ Plane.app/
open /Applications/Agent\ Control\ Plane.app
```

`rsync --delete` 會把 metadata 一起鏡像（可能影響 quarantine）；`ditto` 是更乾淨的選擇，但若環境拒絕 `rm -rf`，rsync 是無需刪除舊目錄的等效部署。

### 注意事項（踩坑記錄）
- 用 `./node_modules/.bin/tauri build`（非 `pnpm tauri build`），避免 pnpm 執行前自動 install prune devDeps 導致 `tauri: not found`。
- 環境若有 `BUILD_ENV=production`，pnpm 會跳過 devDeps（tsc/tauri 消失）→ 前置 `BUILD_ENV=development NODE_ENV=development`。
- 打包的 Control Plane 用 `npm install --omit=dev` 產 flat node_modules（無 symlink），避免 tauri bundler 拷貝 pnpm `.pnpm` store symlink 後斷鏈。
- Tauri 2 的 release build 把前端 assets 編譯期內嵌進 Rust binary（`tauri::generate_context!`），Resources 裡沒有 `index.html` 是正常的；驗證用 `strings <binary> | grep index-*.js`。
- 打包的 app 啟動時 Rust spawn `node <resource_dir>/control-plane/dist/main.js`；若 127.0.0.1:3001 已有 CP 則 attach 不重複 spawn。env 設定化：`ACP_CP_PORT` / `ACP_CP_NODE` / `ACP_CP_PATH` / `ACP_CP_AUTOSTART` / `ACP_CP_DATA_DIR`。
- **CORS 雙路徑陷阱**：`@fastify/cors` 只 hook Fastify 標準 reply 鏈；`src/routes/events.ts` 的 SSE 用 `reply.hijack()` + `res.writeHead(...)`，**完全繞過 cors plugin**，必須手動在 `writeHead` 補 `Access-Control-Allow-Origin: <req Origin>` + `Vary: Origin`。下次若 SSE 又卡「reconnecting」但 fetch 正常，先 curl 這個端點驗 header。

## Pi Worker 模型接入

Pi Worker（`apps/control-plane/src/worker/`）透過 OpenAI-compatible endpoint 串接本地推理引擎，預設 **llama.cpp**（spec §16 原始設計）。連不到時自動降級 stub 快速路徑（§16 備註），`allowStub=false` 可強制真實模型。

### 預設：llama.cpp（:8080）

```bash
# 1) 啟動 llama-server（已測試 qwen2.5-coder-7b Q4_K_M，13.6 t/s）
llama-server -m ~/Projects/mindnav-codeagent/models/qwen2.5-coder-7b-instruct.Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 -c 8192 --n-gpu-layers 99

# 2) Control Plane 零配置（baseUrl 預設 http://127.0.0.1:8080）
pnpm cp:dev
```

### 切換：ollama（:11434）

```bash
# 只需設 baseUrl（client 自動拼 /v1/chat/completions；勿帶 /v1）
LLAMA_BASE_URL=http://127.0.0.1:11434 pnpm cp:dev

# 確認模型存在（policy 預設 qwen2.5-coder:7b）
ollama list
```

> 註：ollama 無 `/health` 端點（404）→ client 會 fallback 到根路徑（200）→ 判定可達 → 走 llama 模式。

### 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `LLAMA_BASE_URL` | `http://127.0.0.1:8080` | llama.cpp / ollama 的 base URL（勿帶 `/v1`） |
| `LLAMA_TIMEOUT_MS` | `300000` | llama 模式生成超時（7B CPU 生成 patch 需 30–120s） |

> 驗證：`curl http://127.0.0.1:8080/health` → `{"status":"ok"}`（llama.cpp）；ollama 檢查 `curl http://127.0.0.1:11434` 回 `Ollama is running`。

## Cloud Provider / Hybrid Execution (T035, Phase 9+)

### Cloud Provider 介面

Control Plane 內建統一的 `CloudProvider` 介面（`apps/control-plane/src/policy/cloud-provider.ts`），支援：

| Provider | 類別 | 預設模型 | 適用場景 |
|---|---|---|---|
| **Anthropic** | `AnthropicProvider` | `claude-3.5-sonnet` | Reviewer/Planner（推理強） |
| **OpenAI** | `OpenAIProvider` | `gpt-4o` | Executor（產出 patch 快） |
| **Google** | `GeminiProvider` | `gemini-1.5-pro` | 成本敏感 / 大上下文 |

透過 `CloudProviderManager` 統一管理：註冊、可用性檢查、成本追蹤（每日上限）、自動重試。

### 四種 Hybrid Escalation Modes（§25）

| Mode | Key | 流程 | 啟用條件 |
|---|---|---|---|
| **Reviewer First** | H | Local 失敗 → Cloud Reviewer 審查 patch → Local 重做 | Local 失敗 ≥ 1 次 |
| **Planner First** | I | Complex task → Cloud Planner 產生計畫 → Local 實作 | 高複雜度 task |
| **Executor First** | J | Critical path → Cloud Executor 產出 patch → Local 驗證 | 高風險 + 多次失敗 |
| **Cloud Only** | K | Full Cloud（Claude/GPT，無 Control Plane） | Phase 11+ 高風險 |

### 環境變數配置（Cloud / Hybrid）

```bash
# Phase 設定（1-11，預設 1，Phase 9+ 才啟用 Hybrid/Cloud）
CP_PHASE=9

# 是否允許 Cloud（Phase 9+ 才生效）
CP_ALLOW_CLOUD=1

# Cloud Provider 選擇：anthropic | openai | gemini
CP_CLOUD_PROVIDER=anthropic

# Cloud API Keys（任一即可；多 Provider 同時註冊亦可）
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...

# 成本控制
CP_MAX_DAILY_COST_USD=50.0       # 每日上限（USD）
CP_MAX_TOKENS_PER_TASK=100000    # 單任務 token 上限

# 可選：自訂 Cloud 模型（預設已內建）
CP_CLOUD_MODEL_REVIEWER=claude-3.5-sonnet
CP_CLOUD_MODEL_PLANNER=claude-3.5-sonnet
CP_CLOUD_MODEL_EXECUTOR=gpt-4o
```

### OpenCode Zen API Key 支援

`OpenCodeProvider` 可直接使用 OpenCode Zen 的兼容端點（OpenAI-compatible）：

```bash
# 方式 1：使用 OpenAI Provider + 自訂 baseUrl
OPENAI_API_KEY=<opencode_zen_key>
OPENAI_BASE_URL=https://api.opencode.ai/v1
CP_CLOUD_PROVIDER=openai

# 方式 2：直接用 OpenCode 專用 Provider（若未來新增）
# OPCODE_API_KEY=<key>
```

### 模型配置位置

| 配置層級 | 檔案/位置 | 說明 |
|---|---|---|
| **Pi Worker 本地模型** | `policies/default.yaml` → `execution.local.model` | 本地 Worker 預設模型（預設 `qwen2.5-coder:7b`） |
| **Pi Worker 本地 Worker ID** | `policies/default.yaml` → `execution.local.worker` | Worker Registry 查找用 |
| **Cloud Reviewer 模型** | `CP_CLOUD_MODEL_REVIEWER` / `policies/default.yaml → execution.cloudModels.reviewer` | Cloud Reviewer 模式用 |
| **Cloud Planner 模型** | `CP_CLOUD_MODEL_PLANNER` / `policies/default.yaml → execution.cloudModels.planner` | Cloud Planner 模式用 |
| **Cloud Executor 模型** | `CP_CLOUD_MODEL_EXECUTOR` / `policies/default.yaml → execution.cloudModels.executor` | Cloud Executor 模式用 |
| **RAG 風格知識庫模型** | `policies/default.yaml` → `rag.model` | Style KB retriever 用 |

> 環境變數優先於 policy YAML；`policies/default.yaml` 為基準配置。

### Hybrid Baseline 執行（T030 + T035）

```bash
# Phase 9 Local Only（Baseline G）
CP_PHASE=9 CP_ALLOW_CLOUD=0 pnpm cp:dev &
python3 scripts/run_baseline.py --baseline G --mode llama --max-tasks 10

# Hybrid Reviewer First（Baseline H）
CP_PHASE=9 CP_ALLOW_CLOUD=1 ANTHROPIC_API_KEY=sk-... python3 scripts/run_baseline.py --baseline H --mode llama --max-tasks 5

# Hybrid Planner First（Baseline I）
CP_PHASE=9 CP_ALLOW_CLOUD=1 ANTHROPIC_API_KEY=sk-... python3 scripts/run_baseline.py --baseline I --mode llama --max-tasks 5

# Hybrid Executor First（Baseline J）
CP_PHASE=9 CP_ALLOW_CLOUD=1 OPENAI_API_KEY=sk-... python3 scripts/run_baseline.py --baseline J --mode llama --max-tasks 5

# Cloud Only（Baseline K）
CP_PHASE=9 CP_ALLOW_CLOUD=1 ANTHROPIC_API_KEY=sk-... python3 scripts/run_baseline.py --baseline K --mode llama --max-tasks 5
```

---

## 任務進度

| 任務 | 內容 | 狀態 |
|---|---|---|
| T001–T004 | Tauri Desktop UI（UI-1~UI-4：scaffold/視覺/SSE/輸入+面板） | ✅ done |
| T005 | Repo scaffold（monorepo + Fastify 骨架） | ✅ done |
| T006 | SQLite schema + Task model + Task Manager | ✅ done |
| T007 | State Machine（§9） | ✅ done |
| T008 | Control Plane API（REST + SSE，§45.5） | ✅ done |
| T009 | CLI（acp 指令集，§29） | ✅ done |
| T010 | Policy Engine（YAML + zod + Knowledge Policy，§10） | ✅ done |
| T011 | Artifact Controller（validate/apply/rollback，§20） | ✅ done |
| T012 | Verification Engine + Sandbox Interface/Registry（§21） | ✅ done |
| T013 | seatbelt（sandbox-exec）adapter + default-deny profile（§28.1） | ✅ done |
| T014 | bwrap（bubblewrap）adapter + §21.2 template | ✅ done |
| T015 | shuru（MicroVM）adapter + selectSandbox step-3 fallback | ✅ done |
| T016 | sandbox switch check + acp verify 真實引擎對接 | ✅ done |
| T017 | Research Engine（Python）+ 4 retrievers + HTTP API（§12） | ✅ done |
| T018 | Evidence model + Bundle + Shaping（§13/§12.2/§27/§30） | ✅ done |
| T019 | Evidence Gate：兩階段評估 + 降級政策 + 卡死防護（§14） | ✅ done |
| T020 | Reflection + Retry：失敗分類器 + 重試政策（§22/§23） | ✅ done |
| T021 | Worker Interface + Pi Worker + llama.cpp 串接（§15/§16） | ✅ done |
| T022 | Worker Registry / Router：註冊與選派（§17） | ✅ done |
| T023 | 第一個 E2E Test（§40）：benchmark/runners/e2e-runner.ts — Policy→Research→Evidence Gate→Pi+llama→Patch→Artifact Gate→pytest，含 T021 驗證失敗回饋重試迴圈 | ✅ done |
| T024 | Benchmark 統計（n≥10 對照實驗，§40 正式數字） | ⏳ next |

詳細任務書：`~/tasks/local-ai-controlpanel/tasks/`

## 安全

- Control Plane 只 bind `127.0.0.1`（§45.3）；Phase 1–5 `allow_cloud: false`（§24）
- WebView capabilities：`core:default` + `opener:allow-open-url`（僅 http/https）；無 filesystem/shell/secrets（§45.3 Rule 4 延伸）
- Sandbox 模式：bwrap（Linux）/seatbelt（macOS）為預設（§21.2）；shuru 為 `security.risk == high` 的操作啟用（§44 Q6）；docker 為 fallback。

規格書：`~/tasks/local-ai-controlpanel/agent-control-plane-spec-v0.5.md`

## License

本專案採用 **Apache License 2.0** 授權。

- 完整授權條款見 [`LICENSE`](LICENSE)（專案根目錄）
- Apache-2.0 官方條款：<https://www.apache.org/licenses/LICENSE-2.0>
- 版權與貢獻者資訊以 LICENSE 檔案為準

> 本專案為研究/模擬用途，授權條款不構成任何投資建議或保證；
> 使用/修改/再散佈前請詳閱 LICENSE 全文。
