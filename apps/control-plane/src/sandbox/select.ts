// selectSandbox（spec §21.2 五步邏輯）。
// 明確指定 → policy 指定 → 高風險 Shuru → 平台預設（seatbelt/bwrap）→ Docker fallback。

import type { SandboxRegistry } from "./registry.js";
import type { Sandbox } from "./types.js";

export interface TaskSandboxHints {
  sandboxMode?: string | null;
  risk?: "low" | "medium" | "high";
}

export interface SandboxPolicyHints {
  sandbox?: { mode?: string; macos_default?: string; linux_default?: string };
  securityLevel?: string;
}

export async function selectSandbox(
  registry: SandboxRegistry,
  task: TaskSandboxHints,
  policy: SandboxPolicyHints,
): Promise<Sandbox> {
  const avail = async (name: string): Promise<Sandbox | undefined> => {
    const sb = registry.get(name);
    if (sb && (await sb.isAvailable())) return sb;
    return undefined;
  };

  // 1. 明確指定模式（task / CLI override）
  if (task.sandboxMode && task.sandboxMode !== "auto") {
    const sb = await avail(task.sandboxMode);
    if (sb) return sb;
  }

  // 2. Policy 強制指定
  const policyMode = policy.sandbox?.mode;
  if (policyMode && policyMode !== "auto") {
    const sb = await avail(policyMode);
    if (sb) return sb;
  }

  // 3. 高風險任務 → Shuru（硬體隔離）
  if (task.risk === "high" || policy.securityLevel === "high") {
    const shuru = await avail("shuru");
    if (shuru) return shuru;
  }

  // 4. 預設：bwrap (Linux) / seatbelt (macOS)
  if (process.platform === "darwin") {
    const seatbelt = await avail("seatbelt");
    if (seatbelt) return seatbelt;
  } else {
    const bwrap = await avail("bwrap");
    if (bwrap) return bwrap;
  }

  // 5. Fallback: Docker
  const docker = await avail("docker");
  if (docker) return docker;

  throw new Error("No sandbox available");
}
