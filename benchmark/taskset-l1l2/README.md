# L1/L2 分級任務集

> **目的**：驗證 ACP 核心命題——「小型模型在自身知識不足的任務上，有研究輔助的成功率顯著高於無研究」。
>
> 詳細設計說明見 `AGENTIC-SEARCH-WORKLOG.md` §9。

## 題庫分級邏輯

| 等級 | 定義 | 預期（CP Gain 假設） |
|------|------|---------------------|
| **L0** 控制組 | 模型原生就會（基本語法/演算法） | research ON ≈ OFF（差距趨近 0，驗證量測系統無偏） |
| **L1** 需 API 知識 | 特定套件的正確用法參數 | ON − OFF ≥ 20pt |
| **L2** 版本特定知識 | 棄用 API 遷移、新版本寫法（訓練資料罕見） | OFF ≈ 0%、ON 可解——最強訊號 |

## 題目清單

| ID | Level | 知識點 | 基線狀態 |
|----|-------|--------|----------|
| L0-calc-divzero | L0 | Python 例外處理 | 1 failed（ValueError vs ZeroDivisionError） |
| L0-str-reverse | L0 | str split/join | 1 failed |
| L1-requests-upload | L1 | files= multipart + timeout | 2 failed（NotImplementedError） |
| L1-sqlalchemy-select | L1 | 2.0 select() 新式語法 | 2 failed |
| L2-pydantic-v2-migration | L2 | v1→v2 遷移（validator/ConfigDict） | 1 failed（白箱檢查禁用 v1 API）+ 行為測試 |
| L2-datetime-utc-deprecated | L2 | 3.12 棄用 API 取代 | 2 failed（DeprecationWarning=error） |

### 防作弊設計

- 所有題目 `tests/**` 在 artifact policy 中為 **readonly**——模型不得改測試
- L1 用 `unittest.mock` 離線斷言**正確的 API 參數用法**（非僅行為正確）
- L2-pydantic 加白箱檢查：source 中不得出現 `@validator` / `orm_mode`
- L2-datetime 將 `DeprecationWarning` 升級為錯誤——用棄用 API 即失敗

## 跑分協議

```bash
# 每題 × {research OFF, research ON} × N≥5
# research OFF：CP_AGENTIC_SEARCH=0 且 CP_MCP_GITHUB_ENABLED=0、SCRAPLING=0、PyPI retriever 停用
# research ON ：全來源啟用 + agentic search 迴圈
```

每 run 記錄：success / attempts / duration / verification results / evidence list。

**判定標準**：
- L1/L2 上 `ON成功率 − OFF成功率 ≥ 20pt` → 核心命題成立
- L0 上差距 ≈ 0 → 量測系統無偏證明
- 若 ON ≈ OFF → 檢視 evidence_utilization 歸因（檢索不足 or 理解不足）
