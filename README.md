# Agent Control Plane — Desktop UI（Tauri v2）

Layer 7 使用者介面（spec §45）。opencode 風格的終端介面：暗色、等寬字體、鍵盤優先、SSE 串流顯示 task 執行。

> **程式碼路徑**：`~/Projects/local-ai-controlpanel`
> **開發規格路徑**：`~/tasks/local-ai-controlpanel`（`agent-control-plane-spec-v0.5.md` 為唯一權威版本）

## 結構

```text
local-ai-controlpanel/
├── src/                    # React + TypeScript 前端（Vite）
│   ├── App.tsx             # 佈局：TopBar / TaskList / TaskStream / InputBar / Palette
│   ├── api/client.ts       # Control Plane REST + SSE client（§45.5 契約）
│   ├── components/
│   └── styles/terminal.css # terminal 暗色主題（§45.4 視覺規範）
└── src-tauri/              # Rust 薄殼（tauri.conf.json / capabilities / commands）
```

## 前置需求（尚未安裝的）

```bash
# 1. Rust toolchain（目前未安裝，需 rustup 或 brew install rust）
rustup-init   # 或 brew install rust

# 2. pnpm
corepack enable  # node 22 內建 corepack

# 3. 產生圖示（tauri.conf.json 引用）
pnpm tauri icon <任意 1024x1024 png>
```

## 開發

```bash
pnpm install
pnpm tauri dev        # 啟動 Rust + WebView（需 Control Plane 在 127.0.0.1:3001）
```

僅前端（無 Rust）：

```bash
pnpm dev              # http://localhost:1420
```

## 連線 Control Plane

- 預設 `http://127.0.0.1:3001`（`VITE_CP_URL` 可覆寫）
- 需要的 endpoint（spec §45.5）：`/api/v1/tasks`、`/api/v1/tasks/:id/events`（SSE）、`/api/v1/sandbox`、`/api/v1/tasks/:id/cancel`

## 安全

- WebView capabilities 只允許：core:default、`shell:allow-open`（僅 http/https external link）
- 無 filesystem / shell / secrets 權限（spec §45.3 Rule 4 延伸）
- CSP 只允許連線 `http://127.0.0.1:*`
