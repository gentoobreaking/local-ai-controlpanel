// GET /api/v1/strategy/:id（spec §45.5）— T008 stub：
// Phase 1–5 固定 local_only（§24 硬限制）；正式 Policy/ExecutionStrategy 於 T010 接入。

import type { FastifyInstance } from "fastify";
import type { TaskManager } from "../task/task-manager.js";

export async function createStrategyRouter(
  app: FastifyInstance,
  opts: { deps: { taskManager: TaskManager } },
): Promise<void> {
  const { taskManager } = opts.deps;

  app.get("/api/v1/strategy/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return {
      taskId: id,
      strategy: "local_only",
      tier: "local",
      worker: "pi-local",
      model: "qwen-9b",
      allowCloud: false,
      maxAttempts: 3,
      note: "stub — Policy Engine 於 T010 接入",
    };
  });
}
