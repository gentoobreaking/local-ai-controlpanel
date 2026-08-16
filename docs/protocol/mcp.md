# MCP Layer（spec §18）

MCP（Model Context Protocol）面向 **Tools / Resources / Prompts**——工具/資源存取層，
與 ACP（任務控制/事件流）不同層。Phase 6+ 啟用，Phase 1–5 預設 `enabled: false`。

## 啟用

```bash
CP_MCP_ENABLED=1 pnpm cp:dev                # 開發模式
cp protocol start --mcp --port 3001         # CLI（spawn Control Plane + MCP）
```

## 傳輸模式

| 模式 | 說明 |
| --- | --- |
| stdio | `apps/control-plane/src/mcp/server.ts` 的 `runStdio()`：JSON-RPC 2.0 一行一則 |
| HTTP+SSE | `POST /mcp`（`Accept: application/json`）；`Accept: text/event-stream` 時以 SSE 回應 |

## 端點

- `POST /mcp` — MCP over HTTP（JSON-RPC 2.0）
- `GET /mcp/health` — 健康檢查（含工具數、協定版本）

## 方法（functional subset）

| Method | 說明 |
| --- | --- |
| `initialize` | 協定版本協商（2024-11-05） |
| `tools/list` | 內部工具清單 |
| `tools/call` | 呼叫工具（先過 Tool Gateway） |
| `resources/list` / `resources/templates/list` | Resource 與模板 |
| `resources/read` | 讀取 Resource |
| `prompts/list` / `prompts/get` | Prompt 模板 |

## 工具（Tool Gateway）

每次 `tools/call` 皆先過 `McpToolGateway` → `PolicyEngine.evaluateTool()`（§18 Rule 4：
MCP 不可繞過 Control Plane Policy）：

- `filesystem.read_file` / `filesystem.list_dir` / `filesystem.write_file`
  （write 需過 §20 Artifact Policy；僅 `ALLOW_IN_SANDBOX`）
- `git.diff` / `git.log` / `git.status`（唯讀）
- `shell.run`（§28 Rule 8：預設在 sandbox 內執行；network default-deny）
- `network.http_get`（本地 Worker 預設禁網）
- `search.code`（workspace 內 substring 搜尋，排除 .git / node_modules）

路徑一律限制在 workspace 內（traversal 阻擋）。

## Resource 模板

| URI 模板 | 內容 |
| --- | --- |
| `file://{path}` | workspace 檔案（§18 掛載：workspace） |
| `git://{ref}/{path}` | git show（§18 掛載：git history） |
| `http://{host}/{path}` | 外部文件唯讀代理 |
| `memory://{namespace}/{key}` | project_memory（tasks / decisions / patterns） |

## Prompt 模板

`code_review`、`debug`、`refactor`、`plan`——皆為純模板（變數取代），不執行任何動作。

## 檔案

- `apps/control-plane/src/mcp/types.ts` — 協定型別
- `apps/control-plane/src/mcp/tools.ts` — 工具註冊 + Tool Gateway
- `apps/control-plane/src/mcp/resources.ts` — Resource 模板
- `apps/control-plane/src/mcp/prompts.ts` — Prompt 模板
- `apps/control-plane/src/mcp/server.ts` — MCP Server（stdio / HTTP+SSE）+ Fastify routes
- `apps/control-plane/src/mcp/client.ts` — MCP Client（連接外部 MCP Server）
