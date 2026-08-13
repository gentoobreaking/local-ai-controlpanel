// Control Plane 執行設定（spec §30 / §45.3）。
// API 只 bind 127.0.0.1——不開放外部網路。

import { fileURLToPath } from "node:url";

/** monorepo root（apps/control-plane/src → ../../..） */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  /** policies/*.yaml 所在目錄（§30）；預設 monorepo root 的 policies/。 */
  policiesDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.CP_HOST ?? "127.0.0.1",
    port: Number(env.CP_PORT ?? 3001),
    dataDir: env.CP_DATA_DIR ?? "./.acp-data",
    policiesDir: env.CP_POLICIES_DIR ?? `${REPO_ROOT}policies`,
  };
}