// SSE 訂閱（T033 --watch）：即時顯示 task 狀態變化（§32 / §45.3）。
// 事件格式：`data: {json}\n\n`（見 apps/control-plane/src/routes/events.ts）。

import type { ApiClient } from "../api.js";

export const TERMINAL_STAGES: ReadonlySet<string> = new Set([
  "COMPLETE",
  "STOP",
  "CANCELLED",
]);

export interface WatchOptions {
  onEvent?: (e: Record<string, unknown>) => void;
  /** 測試/自動化：超過 timeoutMs 即中止（回傳時不視為終態）。 */
  timeoutMs?: number;
}

export interface WatchResult {
  /** 是否等到終態（COMPLETE / STOP / CANCELLED）。 */
  terminal: boolean;
  lastStage?: string;
  lastAttempt?: number;
  eventCount: number;
}

export function e2line(e: Record<string, unknown>): string | undefined {
  if (e.type === "stage" || e.stage !== undefined) {
    const stage = e.stage ?? e.type;
    const attempt = e.attempt !== undefined ? ` (attempt ${String(e.attempt)})` : "";
    const ts = typeof e.ts === "string" ? e.ts.slice(11, 19) : "";
    return `[${ts}] stage=${String(stage)}${attempt}`;
  }
  if (e.type === "done") {
    return `[done] ${String(e.status ?? "")}`;
  }
  return undefined;
}

export async function watchTaskEvents(
  client: ApiClient,
  id: string,
  opts: WatchOptions = {},
): Promise<WatchResult> {
  const abort = new AbortController();
  const timer = opts.timeoutMs
    ? setTimeout(() => abort.abort(), opts.timeoutMs)
    : undefined;
  let res: Response;
  try {
    res = await client.stream(`/api/v1/tasks/${id}/events`, { signal: abort.signal });
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }
  if (!res.ok || !res.body) {
    if (timer) clearTimeout(timer);
    throw new Error(`SSE 訂閱失敗: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let terminal = false;
  let lastStage: string | undefined;
  let lastAttempt: number | undefined;
  let eventCount = 0;

  try {
    while (!abort.signal.aborted) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        break; // abort / 連線中斷 → 停止訂閱
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let e: Record<string, unknown>;
          try {
            e = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          eventCount++;
          opts.onEvent?.(e);
          if (typeof e.stage === "string") {
            lastStage = e.stage;
            if (typeof e.attempt === "number") lastAttempt = e.attempt;
            if (TERMINAL_STAGES.has(e.stage)) terminal = true;
          }
          if (e.type === "done" && typeof e.status === "string") {
            lastStage = e.status;
            if (TERMINAL_STAGES.has(e.status)) terminal = true;
          }
        }
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  return { terminal, lastStage, lastAttempt, eventCount };
}