// cp CLI 完整說明（T033：--help / help）。

export const HELP = `cp — Agent Control Plane CLI（T033, Phase 1–5 local_only）

用法:
  cp <command> [args] [--format json|table|csv|markdown]
  cp --help | help         顯示說明
  cp --version             顯示版本

任務（§9 / §32）:
  cp task create "<request>" [--workspace <path>] [--sandbox auto|bwrap|seatbelt|shuru|docker] [--watch]
      建立新任務；--watch 以 SSE 即時顯示狀態變化
  cp task list [--status <STATUS>] [--format FMT]         列出任務（可依狀態過濾）
  cp task show <id> [--format FMT]                        顯示任務詳情（狀態、attempt、evidence、patches）
  cp task cancel <id>                                     取消任務
  cp task approve <id> [--actor <name>] [--reason <text>] 批准 ASK_USER 任務
  cp task retry <id>                                      重試失敗/中止任務（§23）
  cp task watch <id> [--timeout <sec>]                    SSE 即時追蹤狀態變化

基準執行（§34）:
  cp run <task_id> [--baseline A-F|all] [--mode llama|stub] [--keep]
      執行單一基準任務（task_id 取自 benchmark/tasks/tasks.json，如 T023）
  cp baseline run [--lang <lang>] [--baseline A-F|all] [--max-tasks N] [--tasks ...] [--mode llama|stub] [--keep]
      批次跑分（驅動 benchmark/runners/baseline-runner.ts，T030）

報告 / 資料庫（§36 / §36.4）:
  cp report generate [--baseline A-F|all] [--results-dir <dir>] [--output-dir <dir>]
      生成指標報告（T031 工具鏈：metrics → hallucination → gate → report）
  cp db export [--db <sqlite 路徑>] [--table <name>] [--format json|csv|table|markdown]
      匯出資料庫（預設經 Control Plane REST；--db 直接讀本地檔案）

Worker（§16）:
  cp worker ping            探測 llama.cpp 連線（LLAMA_BASE_URL / LLAMA_MODEL 可覆寫）
  cp worker models          列出可用模型（註冊 + llama-server /v1/models）

既有指令（§29，T009 保留）:
  acp task run / status / inspect
  acp research <id> | acp evidence <id> | acp strategy <id> | acp logs <id>
  acp workers list | acp policy validate [--config <政策目錄>] | acp verify <id> [--sandbox <mode>]
  acp sandbox check | acp cloud usage

通用選項:
  --format json|table|csv|markdown   輸出格式（預設 table）；--json 等同 --format json
  --watch / -w                       即時顯示狀態變化（SSE 訂閱）
  --config <path>                    指定自訂政策檔案/目錄（policy validate local 模式）

環境變數:
  ACP_URL（預設 http://127.0.0.1:3001）、LLAMA_BASE_URL、LLAMA_MODEL、CP_DATA_DIR

範例:
  cp task create "新增 /health 端點" --watch
  cp task list --status COMPLETE --format markdown
  cp task show TASK-001
  cp run T023 --baseline F --mode llama
  cp baseline run --lang python --baseline A --max-tasks 5 --mode stub
  cp report generate
  cp db export --format csv > db-backup.csv
  cp worker ping`;