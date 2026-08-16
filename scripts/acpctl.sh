#!/usr/bin/env bash
# acpctl - Agent Control Plane 控制腳本
# 簡化常用操作：啟動 CP、跑 baseline、生成報告、檢查狀態等

set -euo pipefail

# 顏色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 載入 .env（若存在）
if [[ -f ".env" ]]; then
  set -a
  source .env
  set +a
fi

usage() {
  cat <<'EOF'
Usage: acpctl <command> [options]

Agent Control Plane 統一控制腳本

Commands:
  cp:start        啟動 Control Plane (background)
  cp:stop         停止 Control Plane
  cp:status       檢查 Control Plane 狀態
  cp:logs         顯示 CP 日誌

  baseline:run    執行 Baseline (A-K)
  baseline:report 生成 Benchmark 報告
  baseline:gate   執行 Architecture Validation Gate

  cloud:check     檢查 Cloud Provider 可用性
  cloud:cost      顯示今日雲端成本

  mcp:start       啟用 MCP 協議
  mcp:stop        停用 MCP 協議

  acp:start       啟用 ACP 協議
  acp:stop        停用 ACP 協議

  test            執行所有測試
  typecheck       執行 typecheck
  lint            執行 lint

  env:check       檢查環境變數
  env:example     顯示 .env.example 內容

  help            顯示此幫助

Examples:
  acpctl cp:start
  acpctl baseline:run --baseline A --mode stub --max-tasks 10
  acpctl baseline:run --baseline H --mode llama --max-tasks 5
  acpctl baseline:report
  acpctl cloud:check
  acpctl test
EOF
}

# =============================================================================
# Control Plane 管理
# =============================================================================

cp_pid_file="/tmp/acp-cp.pid"

cp_start() {
  echo -e "${BLUE}🚀 啟動 Control Plane...${NC}"

  if [[ -f "$cp_pid_file" ]] && kill -0 "$(cat "$cp_pid_file")" 2>/dev/null; then
    echo -e "${YELLOW}⚠ Control Plane 已在運行 (PID: $(cat "$cp_pid_file"))${NC}"
    return 0
  fi

  # 檢查 llama.cpp 是否可達（僅警告）
  if ! curl -sf "${LLAMA_BASE_URL:-http://127.0.0.1:8080}/health" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ llama.cpp 未啟動 (${LLAMA_BASE_URL:-http://127.0.0.1:8080})，將使用 stub 模式${NC}"
  fi

  nohup pnpm cp:dev >/tmp/acp-cp.log 2>&1 &
  echo $! > "$cp_pid_file"

  # 等待啟動
  for i in {1..30}; do
    if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
      echo -e "${GREEN}✅ Control Plane 已啟動 (PID: $(cat "$cp_pid_file"))${NC}"
      echo "   Health: http://127.0.0.1:3001/health"
      echo "   Logs:   tail -f /tmp/acp-cp.log"
      return 0
    fi
    sleep 1
  done

  echo -e "${RED}❌ 啟動超時${NC}"
  cat /tmp/acp-cp.log
  return 1
}

cp_stop() {
  echo -e "${BLUE}🛑 停止 Control Plane...${NC}"

  if [[ -f "$cp_pid_file" ]]; then
    local pid=$(cat "$cp_pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo -e "${GREEN}✅ 已停止 (PID: $pid)${NC}"
    else
      echo -e "${YELLOW}⚠ 進程不存在${NC}"
    fi
    rm -f "$cp_pid_file"
  else
    echo -e "${YELLOW}⚠ PID 檔案不存在${NC}"
  fi

  pkill -f "control-plane/dist/main.js" 2>/dev/null || true
}

cp_status() {
  if [[ -f "$cp_pid_file" ]] && kill -0 "$(cat "$cp_pid_file")" 2>/dev/null; then
    echo -e "${GREEN}✅ Control Plane 運行中 (PID: $(cat "$cp_pid_file"))${NC}"
    curl -sf http://127.0.0.1:3001/health | jq . 2>/dev/null || echo "Health check failed"
  else
    echo -e "${RED}❌ Control Plane 未運行${NC}"
  fi
}

cp_logs() {
  if [[ -f /tmp/acp-cp.log ]]; then
    tail -f /tmp/acp-cp.log
  else
    echo "Log file not found"
  fi
}

# =============================================================================
# Baseline 執行
# =============================================================================

baseline_run() {
  local baseline="A"
  local mode="stub"
  local max_tasks=""
  local tasks=""
  local keep=false

  while [[ $# -gt 0 ]]; do
    case $1 in
      --baseline) baseline="$2"; shift 2 ;;
      --mode) mode="$2"; shift 2 ;;
      --max-tasks) max_tasks="$2"; shift 2 ;;
      --tasks) tasks="$2"; shift 2 ;;
      --keep) keep=true; shift ;;
      *) echo "Unknown option: $1"; return 1 ;;
    esac
  done

  echo -e "${BLUE}🏃 執行 Baseline $baseline (mode=$mode)${NC}"

  local cmd="python3 scripts/run_baseline.py --baseline $baseline --mode $mode"
  [[ -n "$max_tasks" ]] && cmd+=" --max-tasks $max_tasks"
  [[ -n "$tasks" ]] && cmd+=" --tasks $tasks"
  [[ "$keep" == true ]] && cmd+=" --keep"

  if ! curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo -e "${YELLOW}Control Plane 未運行，自動啟動...${NC}"
    cp_start
  fi

  eval "$cmd"
}

baseline_report() {
  echo -e "${BLUE}📊 生成 Benchmark 報告...${NC}"
  python3 scripts/generate_report.py \
    --metrics results-keep/t031_metrics.json \
    --gate results-keep/t031_gate_result.json \
    --hallucination results-keep/t031_hallucination_stats.json \
    --output-dir results-keep/t031_reports
}

baseline_gate() {
  echo -e "${BLUE}🚪 執行 Architecture Validation Gate...${NC}"
  python3 scripts/validation_gate.py \
    --metrics results-keep/t031_metrics.json \
    --output results-keep/t031_gate_result.json
}

# =============================================================================
# Cloud Provider 管理
# =============================================================================

cloud_check() {
  echo -e "${BLUE}☁ 檢查 Cloud Provider 可用性...${NC}"

  cat <<EOF > /tmp/cloud_check.mjs
import { createCloudProvider, CloudProviderManager } from "$REPO_ROOT/apps/control-plane/src/policy/cloud-provider.js";

const manager = new CloudProviderManager();

const providers = [
  { type: "anthropic", key: process.env.ANTHROPIC_API_KEY },
  { type: "openai", key: process.env.OPENAI_API_KEY },
  { type: "gemini", key: process.env.GEMINI_API_KEY },
];

for (const p of providers) {
  if (p.key && !p.key.includes("...")) {
    const provider = createCloudProvider(p.type, { apiKey: p.key });
    manager.register(provider);
    const available = await provider.isAvailable();
    console.log(\`\${p.type}: \${available ? "✅ 可用" : "❌ 不可用"}\`);
  } else {
    console.log(\`\${p.type}: ⚠ 未設定 API Key\`);
  }
}
EOF

  npx tsx /tmp/cloud_check.mjs 2>&1 | grep -v "ExperimentalWarning"
}

cloud_cost() {
  echo -e "${BLUE}💰 今日雲端成本...${NC}"

  cat <<EOF > /tmp/cloud_cost.mjs
import { CloudProviderManager } from "$REPO_ROOT/apps/control-plane/src/policy/cloud-provider.js";

const manager = new CloudProviderManager();
console.log(\`今日成本: \$\${manager.getDailyCost().toFixed(4)} USD\`);
console.log(\`每日上限: \$\${process.env.CP_MAX_DAILY_COST_USD || 50} USD\`);
EOF

  npx tsx /tmp/cloud_cost.mjs 2>&1 | grep -v "ExperimentalWarning"
}

# =============================================================================
# MCP / ACP 協議
# =============================================================================

mcp_start() {
  echo -e "${BLUE}🔌 啟用 MCP 協議...${NC}"
  export CP_MCP_ENABLED=1
  export CP_MCP_WORKSPACE="${CP_MCP_WORKSPACE:-$(pwd)}"
  echo "CP_MCP_ENABLED=1"
  echo "CP_MCP_WORKSPACE=$CP_MCP_WORKSPACE"
  echo -e "${GREEN}✅ MCP 已啟用（需重啟 CP 生效）${NC}"
}

mcp_stop() {
  echo -e "${BLUE}🔌 停用 MCP 協議...${NC}"
  unset CP_MCP_ENABLED
  echo -e "${GREEN}✅ MCP 已停用（需重啟 CP 生效）${NC}"
}

acp_start() {
  echo -e "${BLUE}🔌 啟用 ACP 協議...${NC}"
  export CP_ACP_ENABLED=1
  echo -e "${GREEN}✅ ACP 已啟用（需重啟 CP 生效）${NC}"
}

acp_stop() {
  echo -e "${BLUE}🔌 停用 ACP 協議...${NC}"
  unset CP_ACP_ENABLED
  echo -e "${GREEN}✅ ACP 已停用（需重啟 CP 生效）${NC}"
}

# =============================================================================
# 測試 / Typecheck / Lint
# =============================================================================

run_test() {
  echo -e "${BLUE}🧪 執行測試...${NC}"
  pnpm typecheck && pnpm --filter @acp/control-plane test && pnpm --filter @acp/cli test
}

run_typecheck() {
  echo -e "${BLUE}🔍 執行 Typecheck...${NC}"
  pnpm typecheck
}

run_lint() {
  echo -e "${BLUE}🔍 執行 Lint...${NC}"
  pnpm typecheck
}

# =============================================================================
# 環境變數檢查
# =============================================================================

env_check() {
  echo -e "${BLUE}🔍 檢查環境變數...${NC}"

  local required=(
    "LLAMA_BASE_URL"
    "LLAMA_MODEL"
    "CP_PHASE"
  )

  local optional=(
    "ANTHROPIC_API_KEY"
    "OPENAI_API_KEY"
    "GEMINI_API_KEY"
    "CP_ALLOW_CLOUD"
    "CP_CLOUD_PROVIDER"
    "CP_MAX_DAILY_COST_USD"
    "CP_MAX_TOKENS_PER_TASK"
    "OPENAI_BASE_URL"
  )

  echo "Required:"
  for var in "${required[@]}"; do
    if [[ -n "${!var:-}" ]]; then
      echo -e "  ${GREEN}✅${NC} $var=${!var}"
    else
      echo -e "  ${RED}❌${NC} $var (未設定)"
    fi
  done

  echo ""
  echo "Optional:"
  for var in "${optional[@]}"; do
    if [[ -n "${!var:-}" ]]; then
      if [[ "$var" == *"API_KEY"* ]]; then
        echo -e "  ${GREEN}✅${NC} $var=*** (已設定)"
      else
        echo -e "  ${GREEN}✅${NC} $var=${!var}"
      fi
    else
      echo -e "  ${YELLOW}⚠${NC} $var (未設定)"
    fi
  done
}

env_example() {
  cat .env.example
}

# =============================================================================
# Main
# =============================================================================

main() {
  local cmd="${1:-help}"
  shift || true

  case "$cmd" in
    cp:start) cp_start ;;
    cp:stop) cp_stop ;;
    cp:status) cp_status ;;
    cp:logs) cp_logs ;;

    baseline:run) baseline_run "$@" ;;
    baseline:report) baseline_report ;;
    baseline:gate) baseline_gate ;;

    cloud:check) cloud_check ;;
    cloud:cost) cloud_cost ;;

    mcp:start) mcp_start ;;
    mcp:stop) mcp_stop ;;
    acp:start) acp_start ;;
    acp:stop) acp_stop ;;

    test) run_test ;;
    typecheck) run_typecheck ;;
    lint) run_lint ;;

    env:check) env_check ;;
    env:example) env_example ;;

    help|--help|-h) usage ;;
    *)
      echo -e "${RED}Unknown command: $cmd${NC}"
      usage
      exit 1
      ;;
  esac
}

main "$@"