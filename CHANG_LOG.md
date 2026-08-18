# Change Log

All notable changes to the Agent Control Plane project will be documented in this file.

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
| T025 | UI-5：sandbox 整合顯示 + approve 流程（§45.6） | ✅ done |
| T026 | UI-6：打包 + Control Plane 自動啟動/附著（§45.6） | ✅ done |
| T027 | Prompt 注入風格規範（Style Rules Injection） | ✅ done |
| T028 | Few-shot Prompt Engineering（精選錯誤→修正案例） | ✅ done |
| T029 | RAG 風格知識庫（Style Knowledge Base） | ✅ done |
| T030 | Baseline Groups A–E 完整跑分與對照驗證 | ✅ done |
| T031 | CP Gain / Intelligence Efficiency / Research ROI 指標計算與自動化報告 | ✅ done |
| T032 | Memory / Project Memory Retrieval 接入 Pi Worker | ✅ done |
| T033 | CLI 完善與使用者介面 | ✅ done |
| T034 | MCP / ACP 協議層實作（Phase 6+ 預留） | ✅ done |
| T035 | Phase 9 Hybrid Execution / Cloud Escalation 實作 | ✅ done |
| T036 | Spec v0.5 vs 實作完整度審查與差距清單產出 | ✅ done |
| T037 | Research Engine 實作 | ✅ done |
| T038 | Evidence Model 實作 | ✅ done |
| T039 | Evidence Gate 實作 | ✅ done |
| T040 | Artifact Controller (canonicalizeDiff) 實作 | ✅ done |
| T041 | Plugin System 實作與多層 MCP 整合 | ✅ done |
| | 外部 MCP Server 自動啟動與 stdio JSON-RPC Proxy（tw-quant/yfinance/finmind） | ✅ done |

詳細任務書：`~/tasks/local-ai-controlpanel/tasks/`

---

> 本變更日誌記錄專案的主要里程碑與功能實作進度。若需追蹤細部開發過程，請參閱 `~/tasks/local-ai-controlpanel/tasks/` 下的任務書。