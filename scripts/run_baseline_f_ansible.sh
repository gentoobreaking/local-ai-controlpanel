#!/usr/bin/env bash
# Baseline F (研究開啟，llama ON) - Ansible tasks
# 跑 Ansible 10 tasks 的 Baseline F

set -e

cd ~/Projects/local-ai-controlpanel

echo "🚀 Baseline F - Ansible tasks"
echo "=============================="
echo "Model: robit/ornith:9b"
echo "Base URL: http://127.0.0.1:11434"
echo ""

LLAMA_BASE_URL=http://127.0.0.1:11434 \
LLAMA_MODEL=robit/ornith:9b \
npx tsx benchmark/runners/e2e-runner.ts --mode=llama --only=on --keep 2>&1 | tee results-keep/t024_baseline_f/ansible_$(date +%Y%m%d_%H%M%S).log

echo ""
echo "✅ Ansible tasks Baseline F 完成"
echo "結果已儲存至 results-keep/t024_baseline_f/"