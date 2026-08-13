// GET /api/v1/sandbox（spec §45.5）：以 SandboxRegistry 的 isAvailable 探測
// 四後端真實狀態（T013/T014/T015 起為真）。

import type { FastifyInstance } from "fastify";
import type { SandboxRegistry } from "../sandbox/registry.js";

export async function createSandboxRouter(
  app: FastifyInstance,
  opts: { deps: { registry: SandboxRegistry } },
): Promise<void> {
  const { registry } = opts.deps;
  app.get("/api/v1/sandbox", async () => {
    const probe = async (name: string) => {
      const sb = registry.get(name);
      return sb ? sb.isAvailable() : false;
    };
    return {
      bwrap: await probe("bwrap"),
      seatbelt: await probe("seatbelt"),
      shuru: await probe("shuru"),
      docker: await probe("docker"),
    };
  });
}
