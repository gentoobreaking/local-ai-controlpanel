// Worker 指令（T033 §16）：cp worker ping / cp worker models。

import { parseArgs } from "../flags.js";
import { renderRows, renderJson, type OutputFormat } from "../format.js";
import { errMessage, type CliContext } from "../context.js";
import type { CliHttpError } from "../api.js";
import type { CommandResult } from "../command-types.js";

function usage(msg: string): CommandResult {
  return { code: 2, lines: [msg] };
}

export async function workerPing(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(args, ["--format"], ["--json"]);
  const fmt: OutputFormat = bools.has("--json") ? "json" : ((flags.get("--format") ?? "table") as OutputFormat);
  try {
    const res = await ctx.client.workerPing();
    if (fmt === "json") {
      return { code: res.ok ? 0 : 1, lines: renderJson(res) };
    }
    const lines = res.ok
      ? [
          `llama.cpp 連線正常: ${res.baseUrl}`,
          `模型: ${res.model}`,
          `延遲: ${res.latencyMs ?? "-"} ms`,
          ...(res.detail ? [`detail: ${res.detail}`] : []),
        ]
      : [
          `llama.cpp 連線失敗: ${res.baseUrl}`,
          ...(res.detail ? [`detail: ${res.detail}`] : []),
          "提示: 啟動 llama-server / ollama 後再試（LLAMA_BASE_URL 可指定端點）",
        ];
    return { code: res.ok ? 0 : 1, lines };
  } catch (err) {
    const e = err as CliHttpError;
    if (e.status === 503 || e.status === 500) {
      const body = (e.body ?? {}) as {
        ok?: boolean;
        baseUrl?: string;
        model?: string;
        latencyMs?: number;
        detail?: string;
      };
      const lines = [
        `llama.cpp 連線失敗: ${body.baseUrl ?? "-"}`,
        ...(body.detail ? [`detail: ${body.detail}`] : []),
        ...(body.latencyMs !== undefined ? [`延遲: ${body.latencyMs} ms`] : []),
        "提示: 啟動 llama-server / ollama 後再試（LLAMA_BASE_URL 可指定端點）",
      ];
      return { code: 1, lines };
    }
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}

export async function workerModels(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(args, ["--format"], ["--json"]);
  const fmt: OutputFormat = bools.has("--json") ? "json" : ((flags.get("--format") ?? "table") as OutputFormat);
  try {
    const res = await ctx.client.workerModels();
    if (fmt === "json") {
      return { code: 0, lines: renderJson(res) };
    }
    const lines = [`llama-server: ${res.baseUrl}（default model: ${res.defaultModel}）`];
    lines.push("註冊 worker:");
    lines.push(
      ...renderRows(fmt === "markdown" || fmt === "csv" ? fmt : "table", ["WORKER", "RUNTIME", "MODELS", "ENABLED"], [
        ...res.registered.map((w) => [
          w.worker,
          w.runtime,
          w.models.join(", ") || "-",
          String(w.enabled),
        ]),
      ]),
    );
    if (res.server === null) {
      lines.push("llama-server 未回應 /v1/models（僅顯示註冊清單）");
    } else if (res.server.length === 0) {
      lines.push("llama-server 已連線但未載入任何模型");
    } else {
      lines.push("llama-server 已載入模型:");
      lines.push(
        ...renderRows(fmt === "markdown" || fmt === "csv" ? fmt : "table", ["ID", "OBJECT"], [
          ...res.server.map((m) => [m.id, m.object]),
        ]),
      );
    }
    return { code: 0, lines };
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}

export function workerUsage(): CommandResult {
  return usage("用法: cp worker <ping|models>（完整說明: cp --help）");
}