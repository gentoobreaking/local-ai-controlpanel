#!/usr/bin/env bash
# 將 L1/L2 題庫各 fixture 初始化為獨立 git workspace（pipeline 需要）
# 用法：./scripts/prepare-taskset.sh [BASE_DIR]（預設 benchmark/taskset-l1l2）
set -e
BASE="${1:-$(dirname "$0")/../benchmark/taskset-l1l2}"
for d in "$BASE"/L*/; do
  name=$(basename "$d")
  if [ -d "$d/.git" ]; then
    echo "✓ $name already initialized"
    continue
  fi
  cd "$d"
  git init -q
  git add -A
  git commit -qm "baseline"
  echo "✓ $name initialized ($(git rev-parse --short HEAD))"
  cd - >/dev/null
done
echo "題庫就緒：每個 fixture 已是獨立 git workspace"
