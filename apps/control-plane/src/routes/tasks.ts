// REST routes（spec §45.5）。
// 只 bind 127.0.0.1；request/response 以 zod 驗證（§6 選型）。

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TaskManager } from "../task/task-manager.js";
import type { TaskRunner } from "../runner.js";

const CreateTaskSchema = z.object({
  userRequest: z.string().min(1),
  workspace: z.string().optional(),
  sandboxMode: z
    .enum(["auto", "bwrap", "seatbelt", "shuru", "docker"])
    .optional(),
});

const ApproveSchema = z.object({
  kind: z.enum(["artifact", "degraded", "escalation", "block"]).optional(),
  actor: z.string().optional(),
  reason: z.string().optional(),
});

export interface TasksRouteDeps {
  taskManager: TaskManager;
  runner: TaskRunner;
}

export async function createTaskRouter(
  app: FastifyInstance,
  opts: { deps: TasksRouteDeps },
): Promise<void> {
  const { taskManager, runner } = opts.deps;

  app.post("/api/v1/tasks", async (req, reply) => {
    const body = CreateTaskSchema.parse(req.body);
    const task = taskManager.create({
      userRequest: body.userRequest,
      workspace: body.workspace,
      sandboxMode: body.sandboxMode,
    });
    runner.start(task.id);
    return reply.code(201).send(taskManager.toDetail(taskManager.getRow(task.id)!));
  });

  app.get("/api/v1/tasks", async () => {
    return taskManager.list().map((t) => taskManager.toSummary(t));
  });

  app.get("/api/v1/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return taskManager.toDetail(task);
  });

  app.post("/api/v1/tasks/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    runner.cancel(id);
    return { id, status: taskManager.getRow(id)!.status };
  });

  // T033：手動重試失敗任務（COMPLETE 除外）。重置為 CREATED 並由 runner 重跑完整 pipeline。
  app.post("/api/v1/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (task.status === "COMPLETE") {
      return reply.code(409).send({ error: "已完成任務不可重試", status: task.status });
    }
    taskManager.updateStatus(id, "CREATED");
    runner.start(id);
    return {
      id,
      status: taskManager.getRow(id)!.status,
      retried: true,
      progress: `cp task show ${id}`,
    };
  });

  // T033：task show 的 patches 區塊（§20 patches 表）。
  app.get("/api/v1/tasks/:id/patches", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const patches = taskManager.db
      .prepare(
        "SELECT id, attempt, path, status, workspace_dir, created_at FROM patches WHERE task_id = ? ORDER BY created_at",
      )
      .all(id);
    return { taskId: id, patches };
  });

  app.post("/api/v1/tasks/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskManager.getRow(id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const body = ApproveSchema.parse(req.body ?? {});
    taskManager.recordApproval(
      id,
      body.kind ?? "block",
      body.actor ?? "unknown",
      body.reason,
    );
    runner.approve(id);
    return {
      id,
      status: taskManager.getRow(id)!.status,
      approved: true,
      actor: body.actor ?? "unknown",
    };
  });
}
