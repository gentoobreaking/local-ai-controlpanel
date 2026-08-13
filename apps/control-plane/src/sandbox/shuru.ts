// Shuru（SuperHQ MicroVM）adapter（spec §21.2 / §30）。
// Phase 2 只要求 interface 對接（§38）；映像快照等由 config 控制。high-risk 可選。

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "./types.js";

function hasBinary(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    spawn("which", [name], { stdio: "ignore" })
      .on("error", () => resolve(false))
      .on("exit", (code) => resolve(code === 0));
  });
}

export interface ShuruSandboxConfig {
  /** image，預設 shuru/alpine:3.20（§30） */
  image?: string;
  /** memory 預設 512MiB（§30） */
  memory?: string;
  /** cpus 預設 1（§30） */
  cpus?: string;
  executable?: string;
}

/** §21.2/§30 shuru 命令模板 */
export function buildShuruArgs(context: SandboxRunContext, config: ShuruSandboxConfig = {}): string[] {
  const image = config.image ?? "shuru/alpine:3.20";
  const memory = config.memory ?? "512MiB";
  const cpus = config.cpus ?? "1";
  const workspace = realpathSync(context.cwd);
  // shuru 接受布林值：--network true | --network false（§30 network: false）
  const args = [
    "--image", image,
    "--memory", memory,
    "--cpus", cpus,
    "--network", context.network === true ? "true" : "false",
    "--snapshot",
    "--volume", `${workspace}:${workspace}:rw`,
  ];
  for (const m of context.mounts ?? []) {
    args.push("--volume", `${m.hostPath}:${m.sandboxPath}:${m.writable === true ? "rw" : "ro"}`);
  }
  return args;
}

export class ShuruSandbox implements Sandbox {
  readonly name = "shuru" as const;
  private readonly executable: string;
  private readonly config: ShuruSandboxConfig;

  constructor(config: ShuruSandboxConfig = {}) {
    this.executable = config.executable ?? "shuru";
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    return hasBinary(this.executable);
  }

  async run(context: SandboxRunContext): Promise<SandboxRunResult> {
    const args = [...buildShuruArgs(context, this.config), ...context.command];
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
        // §28.1：HOME 重導 workspace（MicroVM 內 HOME 應指向工作目錄）
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

export function createShuruSandbox(config: ShuruSandboxConfig = {}): ShuruSandbox {
  return new ShuruSandbox(config);
}
