// acp 指令集（spec §29）。每個指令最後以字串輸出；exit code 反映成敗。

import type { ApiClient, CliHttpError } from "./api.js";

export interface CommandResult {
  code: number;
  lines: string[];
}

export const USAGE = `acp — Agent Control Plane CLI（v0.5, Phase 1–5 local_only）

用法:
  acp task run "<request>" [--sandbox <mode>]  建立並執行任務
  acp task status <id>                         查詢任務狀態
  acp task inspect <id>                        完整任務詳情
  acp task list                                列出所有任務
  acp task cancel <id>                         取消任務
  acp research <id>                            查詢研究階段狀態
  acp evidence <id>                            查詢證據統計
  acp workers list                             列出 worker
  acp policy validate                          驗證 policies/*.yaml
  acp verify <id> [--sandbox <mode>]           執行驗證（T012/T016 接入）
  acp logs <id>                                查詢 attempt/verification/reflection 日誌
  acp strategy <id>                            查詢執行策略
  acp sandbox check                            探測可用 sandbox
  acp cloud usage                              雲端用量（Phase 10+ 未啟用）

環境變數: ACP_URL（預設 http://127.0.0.1:3001）`;

function help(args: string[]): CommandResult {
  return { code: 0, lines: USAGE.split("\n") };
}

async function taskRun(client: ApiClient, args: string[]): Promise<CommandResult> {
  const positional: string[] = [];
  let sandbox: string | undefined;
  let workspace: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--sandbox") {
      sandbox = args[++i];
    } else if (a === "--workspace") {
      workspace = args[++i];
    } else if (a === "--help" || a === "-h") {
      return { code: 0, lines: ["用法: acp task run \"<request>\" [--sandbox <mode>] [--workspace <path>"] };
    } else if (a !== undefined) {
      positional.push(a);
    }
  }
  if (positional.length === 0) {
    return { code: 2, lines: ["錯誤: 缺少 userRequest 參數。用法: acp task run \"<request>\""] };
  }
  const res = await client.createTask({
    userRequest: positional.join(" "),
    workspace,
    sandboxMode: sandbox,
  });
  return {
    code: 0,
    lines: [
      `任務已建立: ${res.id}`,
      `狀態: ${res.status}`,
      `workspace: ${res.workspace ?? "（未指定）"}`,
      `sandbox: ${res.sandboxMode ?? "（policy 決定）"}`,
      `進度: acp task status ${res.id}`,
      `驗證: acp verify ${res.id}`,
    ],
  };
}

async function taskStatus(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  return {
    code: 0,
    lines: [
      `任務 ${t.id}: ${t.status}`,
      `attempt: ${String(t.attempt)}`,
      `sandbox: ${String(t.sandboxMode ?? "-")}`,
      `證據: ${String(t.evidenceCount ?? 0)} 筆`,
      `驗證: ${String(t.verificationSummary?.passed ?? 0)} passed / ${String(t.verificationSummary?.failed ?? 0)} failed`,
    ],
  };
}

async function taskInspect(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  return { code: 0, lines: [JSON.stringify(t, null, 2)] };
}

async function taskList(client: ApiClient): Promise<CommandResult> {
  const res = await client.listTasks();
  if (res.length === 0) return { code: 0, lines: ["（無任務）"] };
  return {
    code: 0,
    lines: [
      "ID\tSTATUS\tATTEMPT\tSANDBOX",
      ...res.map((t) =>
        `${String(t.id)}\t${String(t.status)}\t${String(t.attempt)}\t${String(t.sandboxMode ?? "-")}`,
      ),
    ],
  };
}

async function taskCancel(client: ApiClient, id: string): Promise<CommandResult> {
  const res = await client.cancelTask(id);
  return { code: 0, lines: [`任務 ${res.id} → ${res.status}`] };
}

async function research(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  const status = String(t.status);
  if (status === "RESEARCH_REQUIRED") {
    return {
      code: 0,
      lines: [`任務 ${t.id}: 研究階段尚未開始（等待 Research Engine，T017 接入）`],
    };
  }
  if (status === "RESEARCHING" || status === "RESEARCH_COMPLETE" || status === "ANALYZING") {
    return { code: 0, lines: [`任務 ${t.id}: 研究階段 ${status}`] };
  }
  return { code: 0, lines: [`任務 ${t.id}: 不在研究階段（${status}）`] };
}

async function evidence(client: ApiClient, id: string): Promise<CommandResult> {
  const t = await client.getTask(id);
  const n = Number(t.evidenceCount ?? 0);
  return {
    code: 0,
    lines:
      n === 0
        ? [`任務 ${t.id}: 尚無證據（Research Engine 於 T017 接入）`]
        : [`任務 ${t.id}: ${n} 筆證據`],
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

async function policyValidate(client: ApiClient): Promise<CommandResult> {
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
  return { code: 0, lines };
}

async function verify(client: ApiClient, args: string[]): Promise<CommandResult> {
  const positional: string[] = [];
  let sandbox: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sandbox") sandbox = args[++i];
    else positional.push(args[i]!);
  }
  if (positional.length !== 1) {
    return { code: 2, lines: ["用法: acp verify <id> [--sandbox <mode>"] };
  }
  const res = await client.verifyTask(positional[0]!, { sandboxMode: sandbox });
  const taskId = String(res.taskId ?? positional[0]);
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
  return { code: 0, lines: [`策略 ${s.strategy}: ${JSON.stringify(s)}`] };
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

export async function runCommand(argv: string[], client: ApiClient): Promise<CommandResult> {
  if (argv.length === 0) return help(argv);
  const [cmd, sub, ...rest] = argv;
  try {
    switch (cmd) {
      case "help":
      case "--help":
      case "-h":
        return help(rest);
      case "task":
        if (sub === "run") return await taskRun(client, rest);
        if (sub === "status") return rest[0] ? await taskStatus(client, rest[0]!) : { code: 2, lines: ["用法: acp task status <id>"] };
        if (sub === "inspect") return rest[0] ? await taskInspect(client, rest[0]!) : { code: 2, lines: ["用法: acp task inspect <id>"] };
        if (sub === "list") return await taskList(client);
        if (sub === "cancel") return rest[0] ? await taskCancel(client, rest[0]!) : { code: 2, lines: ["用法: acp task cancel <id>"] };
        return help(rest);
      case "research": {
        const id = sub ?? rest[0];
        return id ? await research(client, id) : { code: 2, lines: ["用法: acp research <id>"] };
      }
      case "evidence": {
        const id = sub ?? rest[0];
        return id ? await evidence(client, id) : { code: 2, lines: ["用法: acp evidence <id>"] };
      }
      case "workers":
        if (sub === "list") return await workersList(client);
        return help(rest);
      case "policy":
        if (sub === "validate") return await policyValidate(client);
        return help(rest);
      case "verify":
        return await verify(client, [sub, ...rest].filter((x) => x !== undefined) as string[]);
      case "logs": {
        const id = sub ?? rest[0];
        return id ? await logs(client, id) : { code: 2, lines: ["用法: acp logs <id>"] };
      }
      case "strategy": {
        const id = sub ?? rest[0];
        return id ? await strategy(client, id) : { code: 2, lines: ["用法: acp strategy <id>"] };
      }
      case "sandbox":
        if (sub === "check") return await sandboxCheck(client);
        return help(rest);
      case "cloud":
        if (sub === "usage") return await cloudUsage();
        return help(rest);
      default:
        return { code: 2, lines: [`未知指令: ${cmd}`, "", ...USAGE.split("\n")] };
    }
  } catch (err) {
    if (err instanceof TypeError) {
      return {
        code: 1,
        lines: ["無法連線 Control Plane（127.0.0.1:3001）。請先執行: pnpm cp:dev"],
      };
    }
    const e = err as CliHttpError & Error;
    if (e.status === 404) return { code: 1, lines: [`任務不存在: ${e.message}`] };
    return { code: 1, lines: [`錯誤: ${e.message}`] };
  }
}