#!/usr/bin/env bash
# =============================================================================
# build-macos.sh — Agent Control Plane macOS 打包一鍵腳本
#
# 流程：
#   1. 檢查環境（pnpm、node）
#   2. pnpm cp:bundle — build Control Plane + 組裝 dist-bundle（flat node_modules）
#   3. tauri build — 前端 build + 內嵌 binary + 產出 .app / .dmg
#   4. (可選) 安裝到 /Applications — 殺舊進程 + ditto 覆蓋
#
# 用法：
#   ./scripts/build-macos.sh            # 只打包
#   ./scripts/build-macos.sh --install  # 打包 + 安裝到 /Applications（建議；含 smoke test）
#   ./scripts/build-macos.sh --skip-bundle  # 跳過 cp:bundle（只 build 前端+tauri）
#   ./scripts/build-macos.sh --clean    # 打包前清 target（完整重編譯）
#   ACP_VERSION=x.y.z ./scripts/build-macos.sh  # 覆寫版本號（預設讀 tauri.conf.json）
#
# 產物：
#   src-tauri/target/release/bundle/macos/Agent Control Plane.app
#   src-tauri/target/release/bundle/dmg/Agent Control Plane_<ver>_<arch>.dmg
#
# 注意：
#   - 用 ./node_modules/.bin/tauri build（非 pnpm tauri build），
#     避免 pnpm 執行前自動 install prune devDeps 導致 tauri not found
#   - BUILD_ENV=development NODE_ENV=development 必須前置，
#     否則環境有 BUILD_ENV=production 時 pnpm 跳過 devDeps（tsc/tauri 消失）
# =============================================================================
set -euo pipefail

# --- 設定 ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_NAME="Agent Control Plane"
# 版本號從 tauri.conf.json 讀取（單一來源），可用 ACP_VERSION 覆寫
APP_VERSION="${ACP_VERSION:-$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])" 2>/dev/null || echo '0.5.0')}"
APP_PATH="/Applications/${APP_NAME}.app"
BUNDLE_DIR="src-tauri/target/release/bundle/macos"
DMG_DIR="src-tauri/target/release/bundle/dmg"
TAURI_BIN="./node_modules/.bin/tauri"

INSTALL=0
SKIP_BUNDLE=0
CLEAN=0

for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --skip-bundle) SKIP_BUNDLE=1 ;;
    --clean) CLEAN=1 ;;
    *) echo "未知參數: $arg" >&2; exit 1 ;;
  esac
done

# --- 環境檢查 ---
command -v pnpm >/dev/null 2>&1 || { echo "❌ 找不到 pnpm" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ 找不到 node" >&2; exit 1; }
[ -x "$TAURI_BIN" ] || { echo "❌ 找不到 $TAURI_BIN（先跑 pnpm install）" >&2; exit 1; }

echo "==> 專案: $REPO_ROOT"

# --- 1. 打包 Control Plane（dist-bundle） ---
if [ "$SKIP_BUNDLE" -eq 0 ]; then
  echo "==> [1/3] cp:bundle — build Control Plane + 組裝 dist-bundle"
  BUILD_ENV=development CI=true pnpm cp:bundle
else
  echo "==> [1/3] 跳過 cp:bundle（--skip-bundle）"
fi

# --- 2. (可選) 清 target ---
if [ "$CLEAN" -eq 1 ]; then
  echo "==> 清理 src-tauri/target（完整重編譯）"
  rm -rf src-tauri/target
fi

# --- 3. tauri build ---
echo "==> [2/3] tauri build — 前端 build + 內嵌 + 打包 .app/.dmg"
BUILD_ENV=development CI=true "$TAURI_BIN" build

echo ""
echo "==> [3/3] 產物（v${APP_VERSION}）："
APP_BUNDLE="$BUNDLE_DIR/${APP_NAME}.app"
# dmg 檔名含版本號（tauri 產出格式：<ProductName>_<ver>_<arch>.dmg）
DMG_FILE="$(ls "$DMG_DIR"/${APP_NAME}_${APP_VERSION}_*.dmg 2>/dev/null | head -1 || true)"
if [ -d "$APP_BUNDLE" ]; then
  APP_SIZE="$(du -sh "$APP_BUNDLE" 2>/dev/null | cut -f1)"
  echo "  .app : $APP_BUNDLE ($APP_SIZE)"
fi
if [ -n "$DMG_FILE" ]; then
  DMG_SIZE="$(du -sh "$DMG_FILE" 2>/dev/null | cut -f1)"
  echo "  .dmg : $DMG_FILE ($DMG_SIZE)"
fi

# --- 4. (可選) 安裝到 /Applications ---
if [ "$INSTALL" -eq 1 ]; then
  echo ""
  echo "==> 安裝到 /Applications（殺舊進程 + ditto 覆蓋）"
  pkill -f "$APP_NAME" 2>/dev/null || true
  # 同步殺 Control Plane 子進程（不然殘留在 3001，新 app attach 會讀到舊版本 binary）
  pkill -f "control-plane/dist/main.js" 2>/dev/null || true
  # 等進程退出（最多 10s），避免 ditto 覆蓋執行中的 app 鎖檔
  for _ in $(seq 1 10); do
    if ! pgrep -f "$APP_NAME" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  # ditto：macOS 原生覆蓋複製，保留 target metadata + quarantine，比 rm+cp 友善
  ditto "$APP_BUNDLE" "$APP_PATH"
  echo "✅ 已安裝: $APP_PATH（v${APP_VERSION}）"
  echo "   （請重新開啟 app；若 Control Plane 3001 有殘留進程，app 會 attach 而非新 spawn）"

  # --- 5. Post-install smoke test（必跑過才算成功） ---
  echo ""
  echo "==> smoke test（啟動 app + 驗證 SSE CORS）"
  open "$APP_PATH"
  for i in $(seq 1 10); do
    if curl -sf --max-time 1 -H "Origin: tauri://localhost" \
        "http://127.0.0.1:3001/api/v1/workers" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  # GET workers（fetch 走 CORS plugin）
  if ! curl -sf --max-time 2 -H "Origin: tauri://localhost" \
      "http://127.0.0.1:3001/api/v1/workers" >/dev/null 2>&1; then
    echo "❌ smoke test 失敗：3001 無回應或 fetch 被 CORS 擋" >&2
    echo "   檢查：log show --predicate 'process == \"acp-desktop\"' --last 30s | grep validateResponse" >&2
    exit 1
  fi
  # SSE 端點（手寫 hijack 路徑，必須手動補 CORS header——易退化）
  SSE_HEADERS=$(curl -sSI --max-time 2 -H "Origin: tauri://localhost" \
    "http://127.0.0.1:3001/api/v1/tasks/TASK-001/events" 2>/dev/null || true)
  if echo "$SSE_HEADERS" | grep -qi "access-control-allow-origin: tauri://localhost"; then
    echo "  ✓ SSE CORS header 正常"
  else
    echo "❌ SSE 缺 CORS header（EventSource 會被 WebKit 拒收）" >&2
    echo "   確認 src/routes/events.ts 有 reflect Origin 的程式碼" >&2
    exit 1
  fi
  echo "✅ smoke test 通過"
fi

echo ""
echo "✅ 完成"
