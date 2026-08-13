// GET /api/v1/strategy/:id（spec §45.5）— Policy Engine 實作（T010）。
// Phase 1–5 強制 local_only（§24）；allow_cloud=true 時評估會 throw。

import type { FastifyInstance } from "fastify";
import type { PolicyEngine } from "../policy/engine.js";
import type { TaskManager } from "../task/task-manager.js";

export async function createStrategyRouter(
  app: FastifyInstance,
  opts: { deps: { taskManager: TaskManager; policyEngine: PolicyEngine } },
): Promise<void> {
  const { taskManager, policyEngine } = opts.deps;

  app.get("/api/v1/strategy/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const s = policyEngine.evaluateExecution();
    return {
      taskId: id,
      strategy: s.strategy,
      tier: s.tier,
      worker: s.worker,
      model: s.model,
      allowCloud: s.allowCloud,
      maxAttempts: s.maxAttempts,
      source: "policy-engine",
    };
  });
}