#!/usr/bin/env bash
# Baseline F (研究開啟，llama ON) - 完整跑分
# 依序跑 Go (11) + Kubernetes (9) + Ansible (10) = 30 tasks

set -e

cd ~/Projects/local-ai-controlpanel

echo "🚀 Baseline F 完整跑分 - Go + Kubernetes + Ansible"
echo "=================================================="
echo "Model: robit/ornith:9b"
echo "Base URL: http://127.0.0.1:11434"
echo "總計: 30 tasks (Go:11 + K8s:9 + Ansible:10)"
echo "預估時間: 4-8 小時"
echo ""

mkdir -p results-keep/t024_baseline_f

# 1. Go tasks
echo ""
echo "▶️  Phase 1/3: Go tasks (11 tasks)"
LLAMA_BASE_URL=http://127.0.0.1:11434 \
LLAMA_MODEL=robit/ornith:9b \
npx tsx benchmark/runners/e2e-runner.ts --mode=llama --only=on --keep 2>&1 | tee results-keep/t024_baseline_f/go_$(date +%Y%m%d_%H%M%S).log

echo "⏸️  休息 30 秒..."
sleep 30

# 2. Kubernetes
echo ""
echo "▶️  Phase 2/3: Kubernetes tasks"
LLAMA_BASE_URL=http://127.0.0.1:11434 \
LLAMA_MODEL=robit/ornith:9b \
npx tsx benchmark/runners/e2e-runner.ts --mode=llama --only=on --keep 2>&1 | tee results-keep/t024_baseline_f/kubernetes_$(date +%Y%m%d_%H%M%S).log

echo "⏸️  休息 30 秒..."
sleep 30

# 3. Ansible
echo ""
echo "▶️  Phase 3/3: Ansible tasks"
LLAMA_BASE_URL=http://127.0.0.1:11434 \
LLAMA_MODEL=robit/ornith:9b \
npx tsx benchmark/runners/e2e-runner.ts --mode=llama --only=on --keep 2>&1 | tee results-keep/t024_baseline_f/ansible_$(date +%Y%m%d_%H%M%S).log

echo ""
echo "✅ 所有 Baseline F 完成！"
echo "結果已儲存至 results-keep/t024_baseline_f/"
ls -la results-keep/t024_baseline_f/