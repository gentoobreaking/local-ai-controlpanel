// CLI 輔助 endpoints（§45.5 之外的 CLI 面向，見 §29）：
// workers / policy validate / verify / logs。
// T009 提供 stub；T010（policy）、T012/T016（verify）接入實作。

import type { FastifyInstance } from "fastify";
import type { TaskManager } from "../task/task-manager.js";

export async function createCliRouter(
  app: FastifyInstance,
  opts: { deps: { taskManager: TaskManager } },
): Promise<void> {
  const { taskManager } = opts.deps;

  // workers list — stub：Phase 1–5 只有 pi-local（T022 接入 WorkerRegistry）
  app.get("/api/v1/workers", async () => ({
    workers: [
      {
        id: "pi-local",
        runtime: "pi",
        model: "qwen-9b",
        tier: "local",
        locality: "local",
        costClass: "free",
        enabled: true,
      },
    ],
    note: "stub — WorkerRegistry 於 T022 接入",
  }));

  // policy validate — stub：T010 載入實際 policies 驗證
  app.get("/api/v1/policy/validate", async () => ({
    valid: true,
    policies: ["default", "coding", "research", "security", "escalation", "sandbox", "kubernetes"],
    note: "stub — PolicyEngine 於 T010 接入",
  }));

  // verify — stub：T012/T016 接入 Verification Engine + Sandbox
  app.post("/api/v1/tasks/:id/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!taskManager.getRow(id)) return reply.code(404).send({ error: "task not found" });
    return reply.code(501).send({
      error: "verification engine 尚未接入（T012/T016）",
      taskId: id,
    });
  });

  // logs — 真實讀取 DB：attempts / verification_results / reflections（§32 event log）
  app.get("/api/v1/tasks/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!taskManager.getRow(id)) return reply.code(404).send({ error: "task not found" });
    const attempts = taskManager.db
      .prepare("SELECT attempt, worker, model, status, created_at FROM attempts WHERE task_id = ? ORDER BY created_at")
      .all(id);
    const verifications = taskManager.db
      .prepare("SELECT verifier, status, sandbox_mode, duration_ms, created_at FROM verification_results WHERE task_id = ? ORDER BY created_at")
      .all(id);
    const reflections = taskManager.db
      .prepare("SELECT attempt, classification, confidence, recommended_action, created_at FROM reflections WHERE task_id = ? ORDER BY created_at")
      .all(id);
    return { taskId: id, attempts, verifications, reflections };
  });
}