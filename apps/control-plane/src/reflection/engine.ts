// Reflection Engine（spec §22 / §23 / §36.2）。
// 不直接修改 code——只分類失敗原因並建議下一步（Rule：Reflection 是 advisor，不是 actor）。
// 分類器為確定性 error-signature 字串掃描（§36.2 第二層 pattern 清單），
// rule-based / LLM 離線輔助（LLM-as-judge 不得進任何報告數字，§36.2 禁止條款）。

export type FailureClass =
  | "coding_error"
  | "knowledge_error"
  | "requirement_error"
  | "environment_error"
  | "tool_error"
  | "model_limitation";

export type RecommendedAction =
  | "retry"
  | "research"
  | "ask_user"
  | "repair_environment"
  | "stop";

export interface ReflectionResult {
  classification: FailureClass;
  confidence: number;
  recommendedAction: RecommendedAction;
  /** 命中的 signature（供除錯 / 交叉驗證）。 */
  matchedSignatures: string[];
}

/** §36.2 第二層：error-signature pattern 清單（確定性，禁止 LLM 判定）。 */
export const ERROR_SIGNATURES: Record<FailureClass, string[]> = {
  // 程式碼錯誤：編譯 / 語法 / type / lint / assertion
  coding_error: [
    "SyntaxError",
    "TypeError",
    "ReferenceError",
    "compile error",
    "Compilation failed",
    "tsc",
    "TS\\d{4}",
    "eslint",
    "lint",
    "AssertionError",
    "test failed",
    "failed test",
    "Cannot find module",
    "Unexpected token",
    "is not a function",
    "is not defined",
    "Property '",
    "Cannot read properties of",
  ],
  // 知識缺口：缺套件 / 缺依賴 / 不知道 API 用法 / 版本敏感
  knowledge_error: [
    "ModuleNotFoundError",
    "No module named",
    "Cannot find package",
    "Package \\[.*\\] not found",
    "unknown option",
    "not recognized",
    "No such option",
    "invalid argument",
    "version mismatch",
    "requires version",
    "does not exist in version",
    "404 Not Found",
    "No such file or directory: 'node_modules",
    "unresolved import",
  ],
  // 需求錯誤：使用者要求不清楚 / 與需求矛盾
  requirement_error: [
    "does not meet requirement",
    "requirement conflict",
    "conflicts with the request",
    "contradicts the request",
    "not what was asked",
    "spec mismatch",
  ],
  // 環境錯誤：缺少工具 / 環境變數 / 權限 / 網路（非程式問題）
  environment_error: [
    "command not found",
    "ENOENT",
    "EACCES",
    "EPERM",
    "permission denied",
    "Cannot find module 'child_process'",
    "no such tool",
    "not installed",
    "Python was not found",
    "ENV",
    "environment variable",
    "network unreachable",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "TLS handshake",
    "certificate",
  ],
  // 工具錯誤：verifier / sandbox / 工具鏈本身的問題
  tool_error: [
    "sandbox",
    "verifier",
    "timeout",
    "timed out",
    "Tool execution failed",
    "internal error",
    "Segmentation fault",
    "panicked",
    "oom",
    "out of memory",
    "Killed",
  ],
  // 模型限制：輸出截斷 / 重複 / 無意義
  model_limitation: [
    "truncated output",
    "output truncated",
    "max tokens",
    "context length",
    "generation stopped",
    "repetitive",
  ],
};

/** 各 failure class 對應的動作（§23 retry.on 表，Phase 1–5 model_limitation → stop）。 */
export const ACTION_BY_CLASS: Record<FailureClass, RecommendedAction> = {
  coding_error: "retry",
  knowledge_error: "research",
  requirement_error: "ask_user",
  environment_error: "repair_environment",
  tool_error: "retry",
  model_limitation: "stop", // Phase 1–5 = STOP（§24），Phase 9 才 stronger_model
};

export interface ClassifyInput {
  /** verification / worker 的輸出（stderr/stdout 合併）。 */
  output: string;
  /** 額外提示（可選：verifier id、attempt）。 */
  hint?: string;
}

/** 掃描 output 找命中的 signature；回傳每 class 命中數。 */
export function scanSignatures(output: string): Map<FailureClass, number> {
  const hits = new Map<FailureClass, number>();
  for (const [cls, patterns] of Object.entries(ERROR_SIGNATURES) as [
    FailureClass,
    string[],
  ][]) {
    let count = 0;
    for (const p of patterns) {
      try {
        const re = new RegExp(p, "i");
        const m = output.match(re);
        if (m) count += 1;
      } catch {
        // 無效 pattern 忽略（不應發生）
      }
    }
    if (count > 0) hits.set(cls, count);
  }
  return hits;
}

/**
 * classify(output) → ReflectionResult。
 * 確定性規則：命中數最多者勝出；confidence = 命中數加權（最高 1.0）。
 * 無任何命中 → 保守分類 coding_error（低信心）。
 */
export function classify(input: ClassifyInput): ReflectionResult {
  const hits = scanSignatures(input.output);
  if (hits.size === 0) {
    return {
      classification: "coding_error",
      confidence: 0.3,
      recommendedAction: ACTION_BY_CLASS.coding_error,
      matchedSignatures: [],
    };
  }
  // 命中數最多（同分時以 ERROR_SIGNATURES 定義順序優先）
  let best: FailureClass = "coding_error";
  let bestCount = 0;
  for (const [cls, count] of hits) {
    if (count > bestCount) {
      best = cls;
      bestCount = count;
    }
  }
  const confidence = Math.min(1.0, 0.5 + bestCount * 0.15);
  const matched: string[] = [];
  for (const p of ERROR_SIGNATURES[best]) {
    try {
      if (new RegExp(p, "i").test(input.output)) matched.push(p);
    } catch {
      // ignore
    }
  }
  return {
    classification: best,
    confidence,
    recommendedAction: ACTION_BY_CLASS[best],
    matchedSignatures: matched,
  };
}

/**
 * retryPolicy（§23）：依 retry.on 表決定動作。
 * policy 的 on 表優先；缺該 class 時用 ACTION_BY_CLASS 預設。
 */
export function resolveRetryAction(
  classification: FailureClass,
  policyOn?: Partial<Record<FailureClass, RecommendedAction>>,
): RecommendedAction {
  const fromPolicy = policyOn?.[classification];
  if (fromPolicy) return fromPolicy;
  return ACTION_BY_CLASS[classification];
}

/** §23：是否允許再試（attempt 已使用次數 < maxAttempts）。 */
export function canRetry(attemptsUsed: number, maxAttempts: number): boolean {
  return attemptsUsed < maxAttempts;
}
