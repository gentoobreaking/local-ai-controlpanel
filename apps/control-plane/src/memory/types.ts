// Project Memory 類型定義（Spec §26）

/** 專案記憶記錄 */
export interface MemoryRecord {
  /** 唯一識別碼 */
  id: string;
  /** 專案名稱（對應 task.workspace 或專案根目錄名） */
  project: string;
  /** 記憶鍵值：語言:錯誤類型:關鍵字（如 "python:F401:import_requests"） */
  key: string;
  /** 記憶內容：成功的修正模式描述 + 關鍵 diff 片段 */
  value: string;
  /** 標籤：用於過濾檢索（如 ["python", "F401", "style_fix"]） */
  tags: string[];
  /** 建立時間 */
  createdAt: string;
  /** 更新時間 */
  updatedAt: string;
}

/** 檢索查詢參數 */
export interface MemoryQuery {
  /** 專案名稱 */
  project: string;
  /** 查詢字串：language + error_type + 關鍵字 */
  query: string;
  /** 回傳筆數上限 */
  topK: number;
  /** 相似度閾值（0-1） */
  threshold?: number;
  /** 可選標籤過濾 */
  tags?: string[];
}

/** 檢索結果 */
export interface MemorySearchResult {
  record: MemoryRecord;
  /** 相似度分數 (0-1) */
  score: number;
}

/** Pi Worker Contract 擴充：加入專案記憶 */
export interface PiContractMemoryExtension {
  /** 從 project_memory 檢索到的相關記憶片段 */
  project_memory: MemoryRecord[];
}

/** 記憶儲存觸發條件 */
export interface MemoryStoreTrigger {
  taskId: string;
  project: string;
  language: string;
  errorType: string;
  fixedDiff: string;
  tags: string[];
}