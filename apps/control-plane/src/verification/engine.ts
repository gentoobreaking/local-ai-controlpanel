// Verification Engine（spec §21）。
// 流程：selectSandbox（§21.2）→ 對每個 plugin detect → 在 sandbox 內執行
// buildCommand（Rule 8：命令一律進 sandbox，不得在 host 直接執行）→
// 以 exit code 判定 PASS/FAIL/ERROR → 寫入 verification_results（§27）。

import type { SandboxRegistry } from "../sandbox/registry.js";
import { selectSandbox } from "../sandbox/select.js";
import type { SandboxRunResult } from "../sandbox/types.js";
import type { VerificationPlugin, VerificationResult, VerificationContext } from "./types.js";

export interface VerificationEngineDeps {
  registry: SandboxRegistry;
  /** §21.2 policy 參數（security.yaml 的 sandbox/securityLevel） */
  policy: { sandbox?: { mode?: string }; securityLevel?: string };
  record(
    taskId: string,
    attempt: number,
    result: VerificationResult,
    sandboxMode: string,
  ): Promise<void> | void;
}

function mapResult(
  plugin: VerificationPlugin,
  run: SandboxRunResult,
): VerificationResult {
  const status =
    run.timedOut || run.exitCode < 0
      ? ("ERROR" as const)
      : run.exitCode === 0
        ? ("PASS" as const)
        : ("FAIL" as const);
  const output =
    (run.stdout && run.stdout.length > 0 ? run.stdout : run.stderr) || "(no output)";
  return {
    verifier: plugin.id,
    status,
    output: output.slice(0, 4000),
    durationMs: run.durationMs,
  };
}

export class VerificationEngine {
  constructor(private readonly deps: VerificationEngineDeps) {}

  /**
   * 對 task workspace 跑所有適用 verifier。
   * rule-8：命令一律透過 sandbox.run()——本 engine 沒有任何直接 exec 路徑。
   */
  async verify(
    ctx: VerificationContext,
    plugins: VerificationPlugin[],
  ): Promise<VerificationResult[]> {
    const sandbox = await selectSandbox(this.deps.registry, ctx.task, this.deps.policy);
    const results: VerificationResult[] = [];
    for (const plugin of plugins) {
      let detected = false;
      try {
        detected = await plugin.detect(ctx);
      } catch {
        detected = false;
      }
      if (!detected) continue;
      const run = await sandbox.run({
        command: plugin.buildCommand(ctx),
        cwd: ctx.workspaceDir,
        timeout: plugin.timeoutSeconds ?? 120,
        network: false,
      });
      const result = mapResult(plugin, run);
      results.push(result);
      await this.deps.record(ctx.taskId, ctx.attempt, result, sandbox.name);
    }
    return results;
  }
}
