// Sandbox Interface（spec §21.1）。所有 Verification 命令一律在 Sandbox 內執行
//（Rule 8）；network 預設 false（default-deny，§28.1）。

export type SandboxName = "bwrap" | "seatbelt" | "shuru" | "docker";

export interface MountMapping {
  /** 來源路徑（host 側） */
  hostPath: string;
  /** 容器/隔離區內路徑 */
  sandboxPath: string;
  /** false → read-only bind */
  writable?: boolean;
}

export interface SandboxRunContext {
  command: string[];
  cwd: string;
  env?: Record<string, string>;
  mounts?: MountMapping[];
  /** default: false（default-deny，§28.1） */
  network?: boolean;
  /** seconds，default: 120 */
  timeout?: number;
  cpuLimit?: number;
  memoryLimitMb?: number;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Sandbox {
  name: SandboxName;
  isAvailable(): Promise<boolean>;
  run(context: SandboxRunContext): Promise<SandboxRunResult>;
}
