# ACP-Protocol Layer（spec §19）

ACP（Agent Control Protocol）用於 `Control Plane ↕ Agent Runtime`（而不是
`Control Plane ↕ Tool`）。Pi 可視為一個 ACP Agent：Control Plane 對它
`spawn / send request / receive event / interrupt / terminate`。
Phase 6+ 啟用，Phase 1–5 預設 `enabled: false`。

## 啟用

```bash
CP_ACP_ENABLED=1 pnpm cp:dev                # 開發模式
cp protocol start --acp --port 3001         # CLI（spawn Control Plane + ACP）
```

## 傳輸

現階段以 **HTTP 長輪詢**實作（WebSocket 為 Phase 6+ 選項）。

| Method | 說明 |
| --- | --- |
| `POST /acp/session` | handshake（hello / hello_ack；可 resume） |
| `POST /acp/poll` | 事件長輪詢（帶 `ackSeq` / `limit`；timeout 內無事件回空） |
| `POST /acp/control` | 控制指令（Approve / Cancel / Retry / Escalate / InjectFeedback） |
| `POST /acp/tasks` | 外部 runtime 委派任務（TaskRequest） |
| `POST /acp/heartbeat` | session 保活 |
| `POST /acp/session/terminate` | 終止 session |
| `GET /acp/sessions` / `GET /acp/health` | session 清單 / 健康檢查 |

## 訊息

- `TaskRequest` — 建立任務（request / workspace / sandboxMode / risk…）
- `TaskResponse` — accepted / rejected / running / complete / failed
- `Event` — 事件流（見下）
- `Control` — 控制指令（含 `payload`，如 InjectFeedback 的 feedback）

## 事件流

`server.ts` 包覆 event bus（`subscribeAllTasks`）直接把 runner 的 `StageEvent`
轉發為 ACP Event：

| ACP Event | 對應 StageEvent |
| --- | --- |
| `TaskCreated` | ACP 建立任務時發出 |
| `StageChanged` | `stage`（stage / attempt） |
| `EvidenceCollected` | `evidence`（evidenceCount / confidence） |
| `PatchGenerated` | 進入 `ARTIFACT_VALIDATION` 時合成 |
| `VerificationCompleted` | `verification`（verifier / status / sandbox） |
| `ReflectionTriggered` | `reflection`（classification / action） |
| `TaskCompleted` | `done`（status） |

每個事件帶 session 內單調遞增的 `seq`；client 以 `ackSeq` 確認，resume 時自動 replay。

## 控制指令

| Action | 行為 | Phase 1–5 |
| --- | --- | --- |
| `Approve` | runner.approve（ASK_USER 任務） | ok |
| `Cancel` | runner.cancel（非終態） | ok |
| `Retry` | 重置 CREATED + runner.start（COMPLETE 除外） | ok |
| `Escalate` | 記錄 + 回報 NOT_SUPPORTED（§25） | NOT_SUPPORTED |
| `InjectFeedback` | 以 task flag 注入 feedback | ok |

## Session 管理

`acp/session.ts`：create / resume / terminate / heartbeat；TTL 5 分鐘，`reap()` 可 GC。

## 檔案

- `apps/control-plane/src/acp/protocol.ts` — 訊息定義 + StageEvent 映射
- `apps/control-plane/src/acp/session.ts` — Session 管理
- `apps/control-plane/src/acp/server.ts` — ACP Server（長輪詢）+ Fastify routes
- `apps/control-plane/src/acp/client.ts` — ACP Client（連接外部 ACP Agent）

## 圖例（§19）

```text
Control Plane ↕ Pi        （已於 v0.3 建立 abstraction boundary）
Control Plane ↕ OpenCode  （v0.4 / Phase 6+ 實作）
```