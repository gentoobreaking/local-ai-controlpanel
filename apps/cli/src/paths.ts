// 路徑 helper：monorepo root 解析（apps/cli/src/paths.ts → repo root）。

import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}