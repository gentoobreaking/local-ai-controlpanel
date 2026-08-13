// GET /api/v1/sandbox（spec §45.5）— T008 stub：
// 以 which 偵測後端可用性；正式 SandboxRegistry 於 T012/T016 接入。

import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";

function available(cmd: string): boolean {
  const r = spawnSync("which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

export async function createSandboxRouter(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/sandbox", async () => ({
    bwrap: available("bwrap"),
    seatbelt: available("sandbox-exec"),
    shuru: available("shuru"),
    docker: available("docker"),
  }));
}
