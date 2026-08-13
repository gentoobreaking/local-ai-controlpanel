// Verification Engine 型別（spec §21）。
// Verification 絕對不交給 LLM 判斷——一律以實際指令結果為準。

export type VerificationStatus = "PASS" | "FAIL" | "ERROR";

export interface VerificationResult {
  verifier: string;
  status: VerificationStatus;
  output: string;
  durationMs: number;
}

/** detect 用的最小 repository 面貌（完整 RepositoryContext 於 T021/T022 接入） */
export interface VerificationRepositoryContext {
  path: string;
  languages: string[];
  frameworks: string[];
  hasPackageJson: boolean;
  hasTsConfig: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasPyProject: boolean;
  packageScripts: string[];
}

export interface VerificationContext {
  taskId: string;
  attempt: number;
  /** workspace 根（git repo / 專案目錄） */
  workspaceDir: string;
  repo: VerificationRepositoryContext;
  /** sandbox 選擇依據（§21.2） */
  task: { risk?: "low" | "medium" | "high"; sandboxMode?: string | null };
}

export interface VerificationPlugin {
  id: string;
  /** 此專案是否適用此 verifier */
  detect(context: VerificationContext): Promise<boolean>;
  /** 要執行的命令（在 sandbox 內，Rule 8） */
  buildCommand(context: VerificationContext): string[];
  /** 命令執行超時（秒），sandbox 層套用，default 120 */
  timeoutSeconds?: number;
}
