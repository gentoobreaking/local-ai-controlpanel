// Sandbox 後端 adapter 預留（T013 seatbelt / T014 bwrap / T015 shuru 實作）。
// T012 先提供 isAvailable 探測（command -v），run 擲 NotImplemented——確保
// Verification Engine 的 rule-8 合約（命令一律走 sandbox.run）先被鎖住。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "./types.js";

const execFileAsync = promisify(execFile);

async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync("which", [name]);
    return true;
  } catch {
    return false;
  }
}

export class NotImplementedSandbox implements Sandbox {
  constructor(
    public readonly name: Sandbox["name"],
    private readonly bin: string,
    private readonly task: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    // NotImplemented adapter 無論 binary 是否存在皆不可用（run 會擲錯）
    return false;
  }

  async run(context: SandboxRunContext): Promise<SandboxRunResult> {
    throw new Error(`${this.name} adapter 尚未實作（${this.task}）`);
  }
}

/** 預設四種後端的 factory（§21.1 registry 預設註冊） */
export function createStubSandbox(name: Sandbox["name"]): Sandbox {
  switch (name) {
    case "bwrap":
      return new NotImplementedSandbox("bwrap", "bwrap", "T014");
    case "seatbelt":
      return new NotImplementedSandbox("seatbelt", "sandbox-exec", "T013");
    case "shuru":
      return new NotImplementedSandbox("shuru", "shuru", "T015");
    case "docker":
      return new NotImplementedSandbox("docker", "docker", "T015 之後 Docker fallback");
  }
}
