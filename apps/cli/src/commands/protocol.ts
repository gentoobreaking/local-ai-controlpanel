// cp protocol start（T034 §18/§19）：以 MCP / ACP 協議啟用 Control Plane。
// 預設兩者皆停用（Phase 1–5 保持關閉，§38 Phase 6+ 啟用）；經由 env 開關傳給
// control-plane 程序（CP_MCP_ENABLED / CP_ACP_ENABLED / CP_PORT）。

import { spawn } from "node:child_process";
import { parseArgs, CliUsageError } from "../flags.js";
import type { CliContext } from "../context.js";
import type { CommandResult } from "../command-types.js";
import { repoRoot } from "../paths.js";

function usage(msg: string): CommandResult {
  return { code: 2, lines: [msg] };
}

function spawnControlPlane(extraEnv: Record<string, string>): Promise<{ code: number }> {
  const root = repoRoot();
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "apps/control-plane/src/main.ts"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    child.on("error", (err) => {
      process.stderr.write(`[cp] 啟動 control-plane 失敗: ${err.message}\n`);
      resolve({ code: 1 });
    });
    child.on("exit", (code) => resolve({ code: code ?? 1 }));
  });
}

export async function protocolStart(ctx: CliContext, args: string[]): Promise<CommandResult> {
  const { flags, bools } = parseArgs(args, ["--port"], ["--mcp", "--acp"]);
  const enableMcp = bools.has("--mcp");
  const enableAcp = bools.has("--acp");
  if (!enableMcp && !enableAcp) {
    return usage("用法: cp protocol start [--mcp] [--acp] [--port <port>]（至少指定一個協議）");
  }
  const port = flags.get("--port");
  if (port && !/^\d{1,5}$/.test(port)) {
    throw new CliUsageError(`無效 port: ${port}`);
  }

  const extraEnv: Record<string, string> = {};
  if (enableMcp) extraEnv.CP_MCP_ENABLED = "1";
  if (enableAcp) extraEnv.CP_ACP_ENABLED = "1";
  if (port) extraEnv.CP_PORT = port;

  const protocols = [
    enableMcp ? "MCP(/mcp)" : "",
    enableAcp ? "ACP(/acp)" : "",
  ].filter(Boolean).join(" + ");
  process.stdout.write(`[cp] 以 ${protocols} 啟用 Control Plane（port ${port ?? ctx.baseUrl.split(":").pop() ?? "3001"}）…\n`);
  const { code } = await spawnControlPlane(extraEnv);
  return { code, lines: [code === 0 ? "Control Plane 已結束" : `Control Plane exit=${code}`] };
}