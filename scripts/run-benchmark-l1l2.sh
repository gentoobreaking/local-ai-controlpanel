#!/usr/bin/env bash
# L1/L2 Benchmark 編排：OFF/ON 兩模式 × N runs，隔離 DB（port 3002）
# 用法：./scripts/run-benchmark-l1l2.sh [RUNS] [MODES]（預設 3、"off,on"）
set -e
cd "$(dirname "$0")/.."
RUNS="${1:-3}"
MODES="${2:-off,on}"

for MODE in ${MODES//,/ }; do
  echo "════════════════════════════════════"
  echo " Phase: research $MODE"
  echo "════════════════════════════════════"

  # 清理舊進程與隔離環境
  lsof -ti:3002 | xargs kill -9 2>/dev/null || true
  sleep 1
  rm -rf apps/control-plane/.acp-data-benchmark

  # 啟動 CP（benchmark 專用配置）
  if [ "$MODE" = "off" ]; then
    WEB=0; AGENTIC=0
  else
    WEB=1; AGENTIC=1
  fi
  cd apps/control-plane
  env CP_PORT=3002 \
      CP_DATA_DIR=./.acp-data-benchmark \
      CP_POLICIES_DIR=../../policies \
      CP_SEATBELT_PROFILE=../../sandbox-profiles/verification-default.sb \
      LLAMA_BASE_URL=http://127.0.0.1:11434 \
      LLAMA_MODEL=qwen2.5-coder:7b \
      GITHUB_TOKEN="$(gh auth token 2>/dev/null || echo '')" \
      CP_MCP_GITHUB_ENABLED=$([ "$WEB" = "1" ] && echo 1 || echo 0) \
      CP_MCP_SCRAPLING_ENABLED=$([ "$WEB" = "1" ] && echo 1 || echo 0) \
      CP_WEB_RESEARCH=$WEB \
      CP_AGENTIC_SEARCH=$AGENTIC \
      npx tsx src/main.ts > "/tmp/acp-bench-$MODE.log" 2>&1 &
  CP_PID=$!
  cd - >/dev/null

  # 等 health
  for i in $(seq 1 20); do
    curl -s --max-time 2 http://127.0.0.1:3002/api/v1/worker/ping >/dev/null 2>&1 && break
    sleep 1
  done
  echo "CP ready (pid $CP_PID, research=$MODE)"

  # 跑分
  cd apps/control-plane
  npx tsx ../../benchmark/runners/l1l2-runner.ts --mode "$MODE" --runs "$RUNS"
  cd - >/dev/null

  # 停止本階段 CP
  kill "$CP_PID" 2>/dev/null || true
  sleep 1
done

echo "════════════════════════════════════"
echo "產生報告..."
python3 benchmark/metrics/l1l2_report.py
echo "完成：benchmark/results/l1l2/"
