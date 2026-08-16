// CLI 共用 context / helpers（T033）。

import type { ApiClient } from "./api.js";
import type { OutputFormat } from "./format.js";

export interface CliContext {
  client: ApiClient;
  baseUrl: string;
  fmt: OutputFormat;
}

export interface CliErrorLike {
  status?: number;
  message: string;
}

/** 將 HTTP/連線錯誤轉成單行說明（供各指令輸出）。 */
export function errMessage(err: unknown): string {
  const e = err as CliErrorLike;
  if (e == null) return "未知錯誤";
  if (e.status === 404) return `任務不存在: ${e.message}`;
  if (e.status === 409) return e.message;
  if (e.status === 424) return e.message;
  if (e instanceof TypeError) {
    return "無法連線 Control Plane。請先執行: pnpm cp:dev";
  }
  return e.message ?? String(err);
}