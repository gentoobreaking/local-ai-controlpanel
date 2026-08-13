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
