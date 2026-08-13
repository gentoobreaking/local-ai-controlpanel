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
| T014+ | bwrap / shuru / Research / Benchmark… | ⏳ pending |

詳細任務書：`~/tasks/local-ai-controlpanel/tasks/`

## 安全

- Control Plane 只 bind `127.0.0.1`（§45.3）；Phase 1–5 `allow_cloud: false`（§24）
- WebView capabilities：`core:default` + `opener:allow-open-url`（僅 http/https）；無 filesystem/shell/secrets（§45.3 Rule 4 延伸）

規格書：`~/tasks/local-ai-controlpanel/agent-control-plane-spec-v0.5.md`

## License

本專案採用 **Apache License 2.0** 授權。

- 完整授權條款見 [`LICENSE`](LICENSE)（專案根目錄）
- Apache-2.0 官方條款：<https://www.apache.org/licenses/LICENSE-2.0>
- 版權與貢獻者資訊以 LICENSE 檔案為準

> 本專案為研究/模擬用途，授權條款不構成任何投資建議或保證；
> 使用/修改/再散佈前請詳閱 LICENSE 全文。
