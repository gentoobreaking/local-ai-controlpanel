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
import type { WorkerRegistry } from "../worker/registry.js";
import { LlamaClient, LlamaConnectionError } from "../worker/llama-client.js";

/** llama.cpp 端點設定：與 runner.ts 同源（env 覆寫，預設 localhost:8080）。 */
function llamaEndpoint() {
  return {
    baseUrl: process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080",
    model: process.env.LLAMA_MODEL ?? "qwen2.5-coder:7b",
  };
}

export async function createCliRouter(
  app: FastifyInstance,
  opts: { deps: { taskManager: TaskManager; policies: LoadedPolicies; policyEngine: PolicyEngine; verificationEngine: VerificationEngine; workerRegistry: WorkerRegistry } },
): Promise<void> {
  const { taskManager, policies, verificationEngine, workerRegistry } = opts.deps;

  // workers list — T022 接入 WorkerRegistry（Phase 1–5 只有 pi-local）
  app.get("/api/v1/workers", async () => ({
    workers: workerRegistry.list().map((d) => ({
      id: d.id,
      runtime: d.runtime,
      model: d.models[0] ?? null,
      tier: d.locality,
      locality: d.locality,
      costClass: d.costClass,
      enabled: d.enabled,
      capabilities: d.capabilities,
    })),
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

  // T033 worker ping — 探測 llama.cpp 連線（§16）
  app.get("/api/v1/worker/ping", async (_req, reply) => {
    const { baseUrl, model } = llamaEndpoint();
    const client = new LlamaClient({ baseUrl, model });
    try {
      const result = await client.ping();
      return reply.code(result.ok ? 200 : 503).send({ ok: result.ok, baseUrl, model, latencyMs: result.latencyMs, detail: result.detail });
    } catch (err) {
      const e = err as Error;
      if (e instanceof LlamaConnectionError) {
        return reply.code(503).send({ ok: false, baseUrl, model, detail: e.message });
      }
      return reply.code(500).send({ ok: false, baseUrl, model, detail: e.message });
    }
  });

  // T033 worker models — 註冊的 worker 模型 + llama-server /v1/models（可達時）
  app.get("/api/v1/worker/models", async () => {
    const { baseUrl, model } = llamaEndpoint();
    const registered = workerRegistry.list().map((d) => ({
      worker: d.id,
      runtime: d.runtime,
      models: d.models,
      enabled: d.enabled,
    }));
    let server: Array<{ id: string; object: string }> | null = null;
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string; object: string }> };
        server = data.data ?? [];
      }
    } catch {
      // llama-server 未啟動：只回註冊清單
    }
    return { baseUrl, defaultModel: model, registered, server };
  });

  // T033 db export — 匯出全部（或指定）表供 CLI `cp db export`（§36.4 結果保存）。
  app.get("/api/v1/db/export", async (req) => {
    const q = req.query as { table?: string };
    const db = taskManager.db;
    const tableNames = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    )
      .map((r) => r.name)
      .filter((name) => name !== "evidence_fts");
    const dump: Record<string, Array<Record<string, unknown>>> = {};
    for (const name of tableNames) {
      if (q.table && name !== q.table) continue;
      dump[name] = db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    }
    return { exportedAt: new Date().toISOString(), tables: dump };
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