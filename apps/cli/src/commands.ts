// acp/cp 指令分派（spec §29 + T033 完善）。
// 每支指令最後以 CommandResult 回傳；exit code 反映成敗（0 ok / 1 執行失敗 / 2 用法錯誤）。

import { statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";

import type { ApiClient, CliHttpError } from "./api.js";
import type { OutputFormat } from "./format.js";
import { renderJson } from "./format.js";
import type { CommandResult } from "./command-types.js";
import type { CliContext } from "./context.js";
import { errMessage } from "./context.js";
import { parseArgs, CliUsageError } from "./flags.js";
import { HELP } from "./commands/help.js";
import {
  taskCreate,
  taskList,
  taskShow,
  taskCancel,
  taskApprove,
  taskRetry,
  taskWatch,
  taskRunLegacy,
  taskStatusLegacy,
  usageTask,
} from "./commands/task.js";
import { runSingle, baselineRun } from "./commands/run.js";
import { reportGenerate } from "./commands/report.js";
import { dbExport } from "./commands/db.js";
import { workerPing, workerModels, workerUsage } from "./commands/worker.js";
import { protocolStart } from "./commands/protocol.js";

export type { CommandResult } from "./command-types.js";

export const VERSION = "0.6.0";

export async function runCommand(
  argv: string[],
  client: ApiClient,
  opts: { baseUrl?: string; fmt?: OutputFormat } = {},
): Promise<CommandResult> {
  const ctx: CliContext = {
    client,
    baseUrl: opts.baseUrl ?? defaultBaseUrl(),
    fmt: opts.fmt ?? "table",
  };

  // 容錯：`cp ...` / `acp ...` 首個 token 為程式名（bin 呼叫時 process.argv 不含）。
  let args = argv;
  if (args.length > 0 && (args[0] === "cp" || args[0] === "acp")) {
    args = args.slice(1);
  }

  try {
    if (args.length === 0) return helpResult(args);
    const [cmd, ...rest] = args as [string, ...string[]];
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        return helpResult(rest);
      case "--version":
      case "-v":
        return { code: 0, lines: [`cp CLI v${VERSION}`] };
      case "task":
        return await dispatchTask(ctx, rest);
      case "run":
        return await runSingle(ctx, rest);
      case "baseline":
        if (rest[0] === "run") return await baselineRun(ctx, rest.slice(1));
        return { code: 2, lines: ["用法: cp baseline run [--lang <lang>] [--baseline A-F|all] ...（cp --help）"] };
      case "report":
        if (rest[0] === "generate") return await reportGenerate(ctx, rest.slice(1));
        return { code: 2, lines: ["用法: cp report generate [--baseline A-F|all]（cp --help）"] };
      case "db":
        if (rest[0] === "export") return await dbExport(ctx, rest.slice(1));
        return { code: 2, lines: ["用法: cp db export [--db <path>] [--table <name>] [--format csv|json]（cp --help）"] };
      case "worker":
        return await dispatchWorker(ctx, rest);
      case "workers":
        if (rest[0] === "list") return await workersList(ctx.client);
        return helpResult(rest);
      case "policy":
        return await dispatchPolicy(ctx, rest);
      case "verify":
        return await verify(ctx.client, rest);
      case "research": {
        const id = rest[0] ?? "";
        return id ? await research(ctx.client, id) : { code: 2, lines: ["用法: acp research <id>"] };
      }
      case "evidence": {
        const id = rest[0] ?? "";
        return id ? await evidence(ctx.client, id) : { code: 2, lines: ["用法: acp evidence <id>"] };
      }
      case "logs": {
        const id = rest[0] ?? "";
        return id ? await logs(ctx.client, id) : { code: 2, lines: ["用法: acp logs <id>"] };
      }
      case "strategy": {
        const id = rest[0] ?? "";
        return id ? await strategy(ctx.client, id) : { code: 2, lines: ["用法: acp strategy <id>"] };
      }
      case "sandbox":
        if (rest[0] === "check") return await sandboxCheck(ctx.client);
        return helpResult(rest);
      case "protocol":
        if (rest[0] === "start") return await protocolStart(ctx, rest.slice(1));
        return { code: 2, lines: ["用法: cp protocol start [--mcp] [--acp] [--port <port>]（cp --help）"] };
      case "cloud":
        if (rest[0] === "usage") return cloudUsage();
        return helpResult(rest);
      default:
        return { code: 2, lines: [`未知指令: ${String(cmd)}`, "", ...HELP_SPLIT] };
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      return { code: 2, lines: [`用法錯誤: ${err.message}`] };
    }
    if (err instanceof TypeError) {
      return {
        code: 1,
        lines: ["無法連線 Control Plane（127.0.0.1:3001）。請先執行: pnpm cp:dev"],
      };
    }
    const e = err as CliHttpError & Error;
    if (e.status === 404) return { code: 1, lines: [`任務不存在: ${e.message}`] };
    if (e.status === 409) return { code: 1, lines: [e.message] };
    return { code: 1, lines: [`錯誤: ${e.message}`] };
  }
}

function defaultBaseUrl(): string {
  return process.env.ACP_URL ?? "http://127.0.0.1:3001";
}

function helpResult(_rest: string[]): CommandResult {
  return { code: 0, lines: HELP.split("\n") };
}

const HELP_SPLIT = HELP.split("\n");

// ---- task 分派（T033 新指令 + §29 舊別名） --------------------------------

async function dispatchTask(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const [sub, ...rest] = args as [string, ...string[]];
  switch (sub) {
    case "create":
      return await taskCreate(ctx, rest);
    case "list":
      return await taskList(ctx, rest);
    case "show":
      return await taskShow(ctx, rest);
    case "cancel":
      return await taskCancel(ctx, rest);
    case "approve":
      return await taskApprove(ctx, rest);
    case "retry":
      return await taskRetry(ctx, rest);
    case "watch":
      return await taskWatch(ctx, rest);
    case "run":
      return await taskRunLegacy(ctx.client, rest);
    case "status":
      return rest[0] ? await taskStatusLegacy(ctx.client, rest[0]!) : { code: 2, lines: ["用法: acp task status <id>"] };
    case "inspect": {
      if (!rest[0]) return { code: 2, lines: ["用法: acp task inspect <id>"] };
      const t = await ctx.client.getTask(rest[0]!);
      return { code: 0, lines: renderJson(t) };
    }
    default:
      return usageTask();
  }
}

// ---- worker 分派 ---------------------------------------------------------

async function dispatchWorker(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const [sub, ...rest] = args as [string, ...string[]];
  switch (sub) {
    case "ping":
      return await workerPing(ctx, rest);
    case "models":
      return await workerModels(ctx, rest);
    default:
      return workerUsage();
  }
}

// ---- policy validate（--config 時走本地驗證，T033） -----------------------

async function dispatchPolicy(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const [sub, ...rest] = args as [string, ...string[]];
  if (sub !== "validate") return helpResult(args);
  const { flags } = parseArgs(rest, ["--config"], []);
  const configPath = flags.get("--config");
  if (configPath) return await validatePolicyLocally(configPath);
  return await policyValidateRemote(ctx.client);
}

interface LocalPolicyReport {
  valid: boolean;
  dir: string;
  report: Array<{ name: string; valid: boolean; errors: string[] }>;
}

interface LocalPolicyLoader {
  loadPolicies: (dir: string) => LocalPolicyReport;
}

/** 動態 import control-plane loader：型別以 cast 保留，避免跨 package rootDir 衝突。 */
async function loadPoliciesLocally(): Promise<LocalPolicyLoader> {
  const spec = "../../control-plane/src/policy/loader.js";
  return (await import(spec as string)) as unknown as LocalPolicyLoader;
}

async function validatePolicyLocally(path: string): Promise<CommandResult> {
  const abs = resolve(path);
  let stats;
  try {
    stats = statSync(abs);
  } catch {
    return { code: 1, lines: [`無法讀取: ${path}`] };
  }
  const dir = stats.isDirectory() ? abs : dirname(abs);
  const only = stats.isFile() ? basename(abs) : undefined;
  let loaded: LocalPolicyReport;
  try {
    const loader = await loadPoliciesLocally();
    loaded = loader.loadPolicies(dir);
  } catch (err) {
    return { code: 1, lines: [`載入失敗: ${(err as Error).message}`] };
  }
  const entries = only ? loaded.report.filter((r) => r.name === only) : loaded.report;
  const valid = entries.every((r) => r.valid);
  const lines: string[] = [];
  if (only) lines.push(`valid: ${String(valid)}（${dir}/${only}）`);
  else lines.push(`valid: ${String(valid)}`);
  for (const p of entries) {
    lines.push(`  - ${p.name}: ${p.valid ? "ok" : "INVALID"}`);
    for (const e of p.errors) lines.push(`      ${e}`);
  }
  return { code: valid ? 0 : 1, lines };
}

async function policyValidateRemote(client: ApiClient): Promise<CommandResult> {
  const res = await client.validatePolicy();
  const lines: string[] = [];
  if (res.valid === undefined) {
    return { code: 0, lines: [`valid: ${String(res.valid)}`] };
  }
  lines.push(`valid: ${String(res.valid)}`);
  if (Array.isArray(res.policies)) {
    for (const p of res.policies as { name?: string; valid?: boolean; errors?: string[] }[]) {
      lines.push(`  - ${String(p.name)}: ${p.valid ? "ok" : "INVALID"}`);
      for (const e of p.errors ?? []) lines.push(`      ${e}`);
    }
  }
  return { code: res.valid === true ? 0 : 1, lines };
}

// ---- 既有指令（§29，T009 保留實作） --------------------------------------

async function research(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  const status = String(t.status);
  if (status === "RESEARCH_REQUIRED") {
    return { code: 0, lines: [`任務 ${t.id}: 研究階段尚未開始（等待 Research Engine）`] };
  }
  if (status === "RESEARCHING" || status === "RESEARCH_COMPLETE" || status === "ANALYZING") {
    return { code: 0, lines: [`任務 ${t.id}: 研究階段 ${status}`] };
  }
  return { code: 0, lines: [`任務 ${t.id}: 不在研究階段（${status}）`] };
}

async function evidence(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  return {
    code: 0,
    lines: [`任務 ${t.id}: ${String(t.evidence?.count ?? 0)} 筆證據`],
  };
}

async function workersList(client: ApiClient): Promise<CommandResult> {
  const res = await client.listWorkers();
  return {
    code: 0,
    lines: [
      "ID\tRUNTIME\tMODEL\tTIER\tLOCALITY",
      ...res.workers.map((w) =>
        `${String(w.id)}\t${String(w.runtime)}\t${String(w.model)}\t${String(w.tier)}\t${String(w.locality)}`,
      ),
    ],
  };
}

async function verify(client: ApiClient, args: string[]): Promise<CommandResult> {
  const { positionals, flags } = parseArgs(args, ["--sandbox"], []);
  if (positionals.length !== 1) {
    return { code: 2, lines: ["用法: acp verify <id> [--sandbox <mode>]"] };
  }
  const res = await client.verifyTask(positionals[0]!, { sandboxMode: flags.get("--sandbox") });
  const taskId = String(res.taskId ?? positionals[0]);
  if (res.error) return { code: 1, lines: [`任務 ${taskId}: ${String(res.error)} — ${String(res.message ?? "")}`] };
  const results = (res.results ?? []) as { verifier: string; status: string; output?: string }[];
  const lines = [`任務 ${taskId} ${String(res.status ?? "verified")} — sandbox=${String(res.sandbox ?? "auto")}：`];
  for (const r of results) {
    lines.push(`  - ${r.verifier}: ${r.status}`);
  }
  return { code: 0, lines };
}

async function logs(client: ApiClient, id: string): Promise<CommandResult> {
  const res = await client.getLogs(id);
  const lines: string[] = [`任務 ${res.taskId} 日誌:`];
  lines.push(`  attempts: ${res.attempts.length}`, `  verifications: ${res.verifications.length}`, `  reflections: ${res.reflections.length}`);
  for (const a of res.attempts) lines.push(`  [attempt] ${JSON.stringify(a)}`);
  for (const v of res.verifications) lines.push(`  [verification] ${JSON.stringify(v)}`);
  for (const r of res.reflections) lines.push(`  [reflection] ${JSON.stringify(r)}`);
  return { code: 0, lines };
}

async function strategy(client: ApiClient, id: string): Promise<CommandResult> {
  const s = await client.getStrategy(id);
  return { code: 0, lines: [`策略 ${JSON.stringify(s.strategy ?? "")}: ${JSON.stringify(s)}`] };
}

async function sandboxCheck(client: ApiClient): Promise<CommandResult> {
  const s = await client.checkSandbox();
  const lines: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === "sandboxMode") continue;
    lines.push(`  ${k}: ${v === true ? "可用" : v === false ? "不可用" : String(v)}`);
  }
  return { code: 0, lines: ["sandbox 探測:", ...lines] };
}

async function cloudUsage(): Promise<CommandResult> {
  return {
    code: 0,
    lines: ["雲端用量: Phase 1–5 為 local_only（§24），此功能於 Phase 10+ 啟用"],
  };
}