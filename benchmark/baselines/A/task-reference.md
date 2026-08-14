# Baseline A：Raw 9B 對照（Research OFF）

## 規格 (§34)
- research: false
- model: qwen2.5-coder:7b (ollama)
- 任務：Python 外部庫 `requests`（需 research 才能正確實作，sandbox 無網路）
- 目標：驗證無 research 時的 pipeline 行為（§14.2 on_failed=ask_user）

## 任務對照
- 使用 tasks.json 中 T023 (Python, Level 3, requests) 作為單一 task
- 僅 One task，無 50 tasks 規模

## 驗收標準
- [ ] research OFF → ASK_USER (§14.2)
- [ ] event log 完整存儲 (§32/§36.4)
- [ ] success: false, attempts: 1, evidence: 0
- [ ] CP Gain 比較（與 Baseline F 比較）

## 備註
- 此 baseline 作為對照組，不計入 CP Gain 正式統計（見 T024 §36.3）
- 僅作為基線數據參考
