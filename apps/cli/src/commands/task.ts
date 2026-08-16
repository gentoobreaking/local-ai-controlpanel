// 任務指令（T033）：create / list / show / cancel / approve / retry / watch，
// 以及既有指令（§29）的 task run（create 別名）、task status、task inspect。

import { parseArgs, CliUsageError } from "../flags.js";
import { renderRows, renderJson, type OutputFormat } from "../format.js";
import { errMessage, type CliContext } from "../context.js";
import type { CommandResult } from "../command-types.js";
import type { ApiClient, TaskDetailCli } from "../api.js";
import { TERMINAL_STAGES, watchTaskEvents, e2line } from "./watch.js";

function usage(msg: string): CommandResult {
  return { code: 2, lines: [msg] };
}

function fmtOf(flags: Map<string, string | undefined>, bools: Set<string>): OutputFormat {
  if (bools.has("--json")) return "json";
  return (flags.get("--format") as OutputFormat | undefined) ?? "table";
}

function watchTimeoutSec(flags: Map<string, string | undefined>): number | undefined {
  const v = flags.get("--timeout");
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

function createdLines(ctx: CliContext, t: TaskDetailCli, withProgress: boolean): string[] {
  if (ctx.fmt === "json") return renderJson(t);
  const lines = [
    `任務已建立: ${t.id}`,
    `狀態: ${t.status}`,
    `workspace: ${String(t.workspace ?? "（未指定）")}`,
    `sandbox: ${String(t.sandboxMode ?? "（policy 決定）")}`,
    `attempt: ${String(t.attempt)}`,
  ];
  if (withProgress) {
    lines.push(`進度: cp task watch ${t.id}`);
  }
  return lines;
}

// ---- cp task create -----------------------------------------------------

export async function taskCreate(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(
    args,
    ["--workspace", "--sandbox", "--format", "--timeout"],
    ["--watch", "-w", "--json"],
  );
  if (positionals.length === 0) {
    return usage('用法: cp task create "<request>" [--workspace <path>] [--sandbox auto|bwrap|seatbelt|shuru|docker] [--watch]');
  }
  ctx.fmt = fmtOf(flags, bools);
  const t = await ctx.client.createTask({
    userRequest: positionals.join(" "),
    workspace: flags.get("--workspace"),
    sandboxMode: flags.get("--sandbox"),
  });
  if (!bools.has("--watch")) {
    return { code: 0, lines: createdLines(ctx, t, true) };
  }
  const lines = [...createdLines(ctx, t, false), "訂閱事件（--timeout 可設自動結束；Ctrl-C 手動離開）..."];
  const w = await watchTaskEvents(ctx.client, t.id, {
    onEvent: (e) => {
      const l = e2line(e);
      if (l) lines.push(l);
    },
    timeoutMs: watchTimeoutSec(flags),
  });
  lines.push(
    w.terminal
      ? `完成: ${w.lastStage}`
      : `（未等至終態，最後 stage=${String(w.lastStage ?? "-")}）`,
  );
  return { code: w.terminal ? 0 : 1, lines };
}

// ---- cp task list -------------------------------------------------------

export async function taskList(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(args, ["--status", "--format"], ["--json"]);
  ctx.fmt = fmtOf(flags, bools);
  let tasks;
  try {
    tasks = await ctx.client.listTasks();
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
  const statusFilter = flags.get("--status");
  if (statusFilter) {
    const want = statusFilter.toUpperCase();
    tasks = tasks.filter((t) => t.status.toUpperCase() === want);
  }
  if (ctx.fmt === "json") {
    return { code: 0, lines: renderJson(tasks) };
  }
  if (tasks.length === 0) {
    return { code: 0, lines: statusFilter ? [`（無 ${statusFilter} 任務）`] : ["（無任務）"] };
  }
  const headers = ["ID", "STATUS", "ATTEMPT", "SANDBOX", "UPDATED_AT"];
  const rows = tasks.map((t) => [
    String(t.id),
    String(t.status),
    String(t.attempt),
    String(t.sandboxMode ?? "-"),
    String(t.updatedAt ?? t.updated_at ?? "-"),
  ]);
  return { code: 0, lines: renderRows(ctx.fmt, headers, rows) };
}

// ---- cp task show -------------------------------------------------------

export async function taskShow(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(args, ["--format"], ["--json"]);
  if (positionals.length !== 1) {
    return usage("用法: cp task show <id> [--format json|table|csv|markdown]");
  }
  ctx.fmt = fmtOf(flags, bools);
  const id = positionals[0]!;
  let detail: TaskDetailCli;
  let patches;
  try {
    [detail, patches] = await Promise.all([
      ctx.client.getTask(id),
      ctx.client.getPatches(id),
    ]);
    patches = patches.patches;
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
  if (ctx.fmt === "json") {
    return { code: 0, lines: renderJson({ task: detail, patches }) };
  }
  const lines = [
    `任務 ${detail.id}: ${detail.status}`,
    `attempt: ${String(detail.attempt)}`,
    `sandbox: ${String(detail.sandboxMode ?? "-")}`,
    `complexity: ${String((detail as Record<string, unknown>).complexity ?? "-")}  risk: ${String((detail as Record<string, unknown>).risk ?? "-")}`,
    `workspace: ${String((detail as Record<string, unknown>).workspace ?? "-")}`,
    `evidence: ${detail.evidence ? `${String(detail.evidence.count)} 筆` : "0 筆"}`,
    `verification: ${detail.verification ? `${String(detail.verification.verifier)} = ${String(detail.verification.status)}` : "（無）"}`,
    ...(Array.isArray((detail as Record<string, unknown>).flags) && ((detail as Record<string, unknown>).flags as string[]).length > 0
      ? [`flags: ${String((detail as Record<string, unknown>).flags)}`]
      : []),
  ];
  lines.push(`patches: ${patches.length} 筆`);
  if (patches.length > 0) {
    lines.push(
      ...renderRows(ctx.fmt === "csv" || ctx.fmt === "markdown" ? ctx.fmt : "table", [
        "ID",
        "ATTEMPT",
        "PATH",
        "STATUS",
        "CREATED_AT",
      ], patches.map((p) => [
        String(p.id ?? "").slice(0, 8),
        String(p.attempt ?? ""),
        String(p.path ?? "-"),
        String(p.status ?? ""),
        String(p.created_at ?? ""),
      ])),
    );
  }
  return { code: 0, lines };
}

// ---- cp task cancel -----------------------------------------------------

export async function taskCancel(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(args, ["--format"], ["--json"]);
  if (positionals.length !== 1) {
    return usage("用法: cp task cancel <id>");
  }
  ctx.fmt = fmtOf(flags, bools);
  const id = positionals[0]!;
  try {
    const res = await ctx.client.cancelTask(id);
    if (ctx.fmt === "json") return { code: 0, lines: renderJson(res) };
    return { code: 0, lines: [`任務 ${res.id} → ${res.status}`] };
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}

// ---- cp task approve ----------------------------------------------------

export async function taskApprove(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(
    args,
    ["--format", "--actor", "--reason", "--kind"],
    ["--json"],
  );
  if (positionals.length !== 1) {
    return usage("用法: cp task approve <id> [--actor <name>] [--reason <text>] [--kind artifact|degraded|escalation|block]");
  }
  ctx.fmt = fmtOf(flags, bools);
  const id = positionals[0]!;
  try {
    const res = await ctx.client.approveTask(id, {
      kind: flags.get("--kind"),
      actor: flags.get("--actor") ?? "cli",
      reason: flags.get("--reason"),
    });
    if (ctx.fmt === "json") return { code: 0, lines: renderJson(res) };
    return {
      code: 0,
      lines: [`任務 ${res.id} 已批准（actor: ${res.actor}）→ ${res.status}`, `進度: cp task show ${res.id}`],
    };
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}

// ---- cp task retry ------------------------------------------------------

export async function taskRetry(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(args, ["--format"], ["--json"]);
  if (positionals.length !== 1) {
    return usage("用法: cp task retry <id>");
  }
  ctx.fmt = fmtOf(flags, bools);
  const id = positionals[0]!;
  try {
    const res = await ctx.client.retryTask(id);
    if (ctx.fmt === "json") return { code: 0, lines: renderJson(res) };
    return {
      code: 0,
      lines: [`任務 ${res.id} 已重試（§23 Reflection Retry 手動版）→ ${res.status}`, `進度: cp task show ${res.id}`],
    };
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
}

// ---- cp task watch ------------------------------------------------------

export async function taskWatch(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { positionals, flags, bools } = parseArgs(args, ["--format", "--timeout"], ["--json"]);
  if (positionals.length !== 1) {
    return usage("用法: cp task watch <id> [--timeout <sec>]");
  }
  ctx.fmt = fmtOf(flags, bools);
  const id = positionals[0]!;
  const lines: string[] = [];
  let w;
  try {
    w = await watchTaskEvents(ctx.client, id, {
      onEvent: (e) => {
        const l = e2line(e);
        if (l) lines.push(l);
      },
      timeoutMs: watchTimeoutSec(flags),
    });
  } catch (err) {
    return { code: 1, lines: [`錯誤: ${errMessage(err)}`] };
  }
  lines.push(
    w.terminal
      ? `完成: ${w.lastStage}（event count: ${w.eventCount}）`
      : `（未等至終態，最後 stage=${String(w.lastStage ?? "-")}）`,
  );
  return { code: w.terminal ? 0 : 1, lines };
}

// ---- 既有別名（§29，輸出格式保持與 T009 一致） ----------------------------

export async function taskRunLegacy(client: ApiClient, args: string[]): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(args, ["--sandbox", "--workspace"], []);
  if (positionals.length === 0) {
    return usage('用法: acp task run "<request>" [--sandbox <mode>] [--workspace <path>]');
  }
  const res = await client.createTask({
    userRequest: positionals.join(" "),
    workspace: flags.get("--workspace"),
    sandboxMode: flags.get("--sandbox"),
  });
  return {
    code: 0,
    lines: [
      `任務已建立: ${res.id}`,
      `狀態: ${res.status}`,
      `workspace: ${String(res.workspace ?? "（未指定）")}`,
      `sandbox: ${String(res.sandboxMode ?? "（policy 決定）")}`,
      `進度: acp task status ${res.id}`,
      `驗證: acp verify ${res.id}`,
    ],
  };
}

export async function taskStatusLegacy(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  return {
    code: 0,
    lines: [
      `任務 ${t.id}: ${t.status}`,
      `attempt: ${String(t.attempt)}`,
      `sandbox: ${String(t.sandboxMode ?? "-")}`,
      `證據: ${String(t.evidence?.count ?? 0)} 筆`,
      `驗證: ${t.verification ? `${String(t.verification.verifier)} = ${String(t.verification.status)}` : "（無）"}`,
    ],
  };
}

export function usageTask(): CommandResult {
  return usage('用法: cp task <create|list|show|cancel|approve|retry|watch> ...（完整說明: cp --help）');
}