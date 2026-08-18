# ACP 介面所有功能驗證指南

## 概述

本文檔描述如何驗證 ACP (Agent Control Plane) 介面的所有功能。驗證包含前端 UI、SSE 重連、Worker/Model 資訊、指令歷史、CommandPalette、縮放功能等。

## 前置需求

- Node.js 18+ (pnpm 8+)
- Python 3.10+ (用於 Baseline 執行)
- 瀏覽器 (Chrome/Edge/Firefox)
- API 金鑰 (用於真實雲端驗證)

## 驗證檢核清單

### 1. SSE 重連狀態顯示

**預期行為：**
- 連接狀態顯示為 `● connected` (綠色)
- 斷線後顯示 `○ disconnected` (紅色)
- 重連過程顯示 `⟳ reconnecting…` (黃色，帶有脈動動畫)

**驗證步驟：**
1. 啟動 Control Plane: `acpctl cp:start`
2. 確認 TopBar 顯示 `● connected`
3. 中斷 SSE 連線 (或停止 CP)
4. 確認狀態變更為 `○ disconnected`
5. 重新連線
6. 確認狀態回復為 `● connected`，並出現黃色脈動動畫 `⟳ reconnecting…`

**預期 CSS 類別：**
- `conn-ok` - 綠色
- `conn-reconnecting` - 黃色 + 脈動動畫
- `conn-bad` - 紅色

### 2. Worker/Model 資訊動態刷新

**預期行為：**
- Worker 名稱、模型名稱每 10 秒自動刷新
- 切換任務時即時刷新資訊
- Sandbox Status Badge 顯示正確

**驗證步驟：**
1. 啟動一個 Baseline 任務
2. 觀察 TopBar 中的 Worker/Model 資訊
3. 等待 10 秒，確認資訊是否自動更新
4. 點擊切換不同任務
5. 確認任務切換時資訊即時更新

### 3. Ctrl+K 指令面板

**預期行為：**
- 啟動面板 (Ctrl+K)
- 使用 ↑/↓ 鍵選擇項目
- Enter 選擇命令
- Esc 關閉面板
- 點擊外部區域關閉

**驗證步驟：**
1. 啟動任務以啟用介面
2. 按下 `Ctrl+K` (或點擊面板圖示)
3. 輸入關鍵字搜尋
4. 使用 `↑`/`↓` 鍵導航
5. 點擊 `Enter` 執行選擇的命令
6. 按 `Esc` 確認面板關閉
7. 再次按 `Ctrl+K`，確認 cursor 狀態正確重置

**修復驗證點：**
- cursor 狀態在輸入變化時不應保持
- mouseenter 高亮應正常工作
- ↑/↓/Enter/Esc 所有鍵應正確處理

### 4. 指令歷史下拉選單

**預期行為：**
- 按上/下鍵瀏覽歷史
- 點擊項目填入輸入框
- ESC 中斷選擇 (不清除輸入)
- 最多顯示 20 條歷史記錄
- 顯示索引編號 (1., 2., ...)

**驗證步驟：**
1. 執行幾個任務以產生歷史記錄
2. 使用 `↑` 鍵呼叫歷史下拉
3. 使用 `↓` 鍵向下瀏覽
4. 點擊任一項目確認填入輸入框
5. 按 `ESC` 確認下拉關閉，但輸入框內容未被清除
6. 再次按 `↑` 確認可以上一層瀏覽
7. 驗證最舊的記錄已移除 (僅保留最近 20 條)

### 5. UI 縮放功能

**預期行為：**
- Zoom In: `Ctrl` + `+` (或按 `+` 按鈕)
- Zoom Out: `Ctrl` + `-` (或按 `-` 按鈕)
- Reset Zoom: `Ctrl` + `0` (或按 `⟲` 按鈕)
- 縮放比例顯示在頂部 (e.g., "100%")
- 最大縮放 2.0x，最小縮放 0.5x

**驗證步驟：**
1. 啟動 ACP 介面
2. 預設縮放應為 100%
3. 點擊 `+` 按鈕或按 `Ctrl` + `+`
4. 確認縮放比例增加至約 110-120%
5. 重複點擊 `+` 直到達到 200% 上限
6. 點擊 `-` 按鈕或按 `Ctrl` + `-`
7. 確認縮小至約 90-80%
8. 點擊 `⟲` (重置) 或按 `Ctrl` + `0`
9. 確認回復至 100%

### 6. TaskStream 輸出顯示

**預期行為：**
- 正確顯示 `verification.output` 內容
- 正確顯示 `reflection.output` 內容
- 正確顯示 `done` 事件
- 輸出支援多行顯示 (不只顯示一行)

**驗證步驟：**
1. 執行需要驗證/反思的任務
2. 觀察 TaskStream 下方的輸出區域
3. 確認 verification、reflection、done 事件皆有顯示
4. 確認輸出不只顯示第一行，支援捲動檢視完整內容

### 7. Connection Status in Stream Header

**預期行 behaviour：**
- 重連狀態顯示顏色正確
- `conn-reconnecting` 為黃色
- `conn-bad` 為紅色

**驗證步驟：**
1. 觀察 Stream Header 區域的連線狀態顯示
2. 觸發重連情境
3. 確認狀態顏色隨變化

## 自動化測試

### Control-plane 單元測試

```bash
# 執行所有前端相關測試
pnpm --filter @acp/control-plane test
```

**預期結果：**
- 173 tests pass
- 3 tests fail (既有失敗，非本次引入)
- 2 tests skipped

### CLI 測試

```bash
# 執行 CLI 測試
pnpm --filter @acp/cli test
```

**預期結果：**
- 24/24 tests pass

### 手動驗證腳本

```bash
# 檢查所有功能
acpctl test

# 檢查環境變數
acpctl env:check

# 檢查 Cloud Provider
acpctl cloud:check

# 顯示今日成本
acpctl cloud:cost
```

## 已修復的問題

| 問題 | 修復位置 | Commit |
|---|---|---|
| SSE 重連顯示 | TaskStream.tsx, terminal.css | 472233e |
| Worker/Model 動態刷新 | TopBar.tsx | 472233e |
| Ctrl+K 選擇無效 | CommandPalette.tsx | 472233e |
| 指令歷史下拉選單 | InputBar.tsx | 472233e |
| ESC 中斷功能 | InputBar.tsx | 472233e |
| 輸出顯示一行問題 | TaskStream.tsx | 472233e |
| UI 縮放功能 | App.tsx, terminal.css | 472233e |

## 已知限制

1. **Baseline D/E/F**：需要真實的雲端 API 金鑰 (ANTHROPIC_API_KEY 等) 方可驗證
2. **Phase 9 Hybrid Modes (H/I/J/K)**：需要真實的雲端 API 金鑰實際測試
3. **Line 1-only 輸出顯示問題**：已在 T035 中修復，支援多行顯示

## 疑難排解

### 測試失敗

如果出現測試失敗：

1. 檢查是否為既有失敗 (3 個非預設失敗)
2. 檢查環境變數是否正確設定
3. 檢查 API 金鑰是否有效

### 介面無反應

1. 確認 Control Plane 是否正在運行: `acpctl cp:status`
2. 確認瀏覽器 Console 是否有錯誤訊息
3. 重新整理頁面

### 縮放功能無效

1. 確認已套用 CSS 變數
2. 檢查 zoom state 是否正確初始化
3. 檢查 `transform: scale()` 是否被應用

## 參考資訊

- 專案根目錄: `/Users/david/Projects/local-ai-controlpanel/`
- Git 歷程記錄: `git log --oneline -10`
- Typecheck: `pnpm --filter @acp/control-plane typecheck`
- CLI 測試: `pnpm --filter @acp/cli test`