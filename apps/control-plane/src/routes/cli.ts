// CLI 輔助 endpoints（§45.5 之外的 CLI 面向，見 §29）：
// workers / policy validate / verify / logs。
// T009 提供 stub；T010（policy）、T012/T016（verify）接入實作。

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LoadedPolicies } from "../policy/loader.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { TaskManager } from "../task/task-manager.js";
import type { VerificationEngine } from "../verification/engine.js";
import { DEFAULT_VERIFIERS } from "../verification/verifiers.js";
import { buildVerificationContext } from "../verification/context.js";

export async function createCliRouter(
  app: FastifyInstance,
  opts: { deps: { taskManager: TaskManager; policies: LoadedPolicies; policyEngine: PolicyEngine; verificationEngine: VerificationEngine } },
): Promise<void> {
  const { taskManager, policies, verificationEngine } = opts.deps;

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

  // policy validate — Policy Engine 載入結果（T010 起為真實驗證）
  app.get("/api/v1/policy/validate", async () => ({
    valid: policies.report.every((r) => r.valid),
    dir: policies.dir,
    policies: policies.report.map((r) => ({
      name: r.name,
      valid: r.valid,
      ...(r.errors.length > 0 ? { errors: r.errors } : {}),
    })),
  }));

  // verify — T012/T016 接入 Verification Engine + Sandbox（切換執行）
  const VerifySchema = z.object({
    sandboxMode: z.enum(["auto", "bwrap", "seatbelt", "shuru", "docker"]).optional(),
    workspace: z.string().optional(),
  });
  app.post("/api/v1/tasks/:id/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const body = VerifySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    const workspace = body.data.workspace ?? task.workspace ?? undefined;
    if (!workspace) {
      return reply.code(400).send({
        error: "sandbox mode",
        message: "需要 workspace（傳入 workspace 或於 task run 時指定 --workspace）",
        taskId: id,
      });
    }
    const ctx = {
      taskId: id,
      attempt: task.attempt,
      workspaceDir: workspace,
      repo: buildVerificationContext(workspace),
      task: { risk: task.risk ?? undefined, sandboxMode: body.data.sandboxMode ?? task.sandboxMode ?? undefined },
    };
    try {
      const { sandbox, results } = await verificationEngine.verify(ctx, DEFAULT_VERIFIERS);
      return { taskId: id, attempt: task.attempt, workspace, sandbox, results };
    } catch (err) {
      const e = err as Error;
      if (e.message.includes("No sandbox available")) {
        return reply.code(424).send({ error: "no sandbox available", message: e.message, taskId: id });
      }
      return reply.code(500).send({ error: "verification failed", message: e.message, taskId: id });
    }
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