// Bubblewrap（bwrap）adapter（spec §21.2 Linux 預設）。
// 命令模板：ro-bind 系統目錄、workspace+/tmp 可寫 bind、--unshare-net/ipc/pid、
// --cap-drop ALL --die-with-parent；macOS 上 isAvailable=false（不誤用）。

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "./types.js";

function hasBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    spawn("which", [name], { stdio: "ignore" })
      .on("error", () => resolve(false))
      .on("exit", (code) => resolve(code === 0));
  });
}

/** §21.2 bwrap 命令模板（system 目錄僅 bind 存在者；workspace 可寫 bind） */
export function buildBwrapArgs(
  context: Pick<SandboxRunContext, "cwd" | "mounts" | "network">,
): string[] {
  const bind = (src: string, dst: string, writable: boolean): string[] => [
    writable ? "--bind" : "--ro-bind",
    src,
    dst,
  ];
  const args: string[] = [];
  for (const dir of ["/usr", "/lib", "/bin", "/opt/homebrew"]) {
    if (existsSync(dir)) args.push(...bind(dir, dir, false));
  }
  const workspace = realpathSync(context.cwd);
  args.push(...bind(workspace, context.cwd, true));
  args.push(...bind("/tmp", "/tmp", true));
  for (const m of context.mounts ?? []) {
    if (existsSync(m.hostPath)) args.push(...bind(m.hostPath, m.sandboxPath, m.writable === true));
  }
  args.push("--proc", "/proc", "--dev", "/dev");
  if (context.network !== true) args.push("--unshare-net");
  args.push("--unshare-ipc", "--unshare-pid", "--unshare-user");
  args.push("--die-with-parent", "--cap-drop", "ALL");
  return args;
}

export interface BwrapSandboxConfig {
  executable?: string;
}

export class BwrapSandbox implements Sandbox {
  readonly name = "bwrap" as const;
  private readonly executable: string;

  constructor(config: BwrapSandboxConfig = {}) {
    this.executable = config.executable ?? "bwrap";
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    return hasBinary(this.executable);
  }

  async run(context: SandboxRunContext): Promise<SandboxRunResult> {
    const args = [...buildBwrapArgs(context), ...context.command];
    const timeoutMs = (context.timeout ?? 120) * 1000;
    const started = Date.now();
    const result = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(this.executable, args, {
        cwd: context.cwd,
        // §28.1：HOME 重導 workspace（npm 等需寫 $HOME/.npm）
        env: { ...(context.env ?? process.env), HOME: context.cwd },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => {
        stdout += d;
      });
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: String(err.message), timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
    return {
      ...result,
      stdout: String(result.stdout).slice(0, 100_000),
      stderr: String(result.stderr).slice(0, 100_000),
      durationMs: Date.now() - started,
    };
  }
}

export function createBwrapSandbox(): BwrapSandbox {
  return new BwrapSandbox();
}