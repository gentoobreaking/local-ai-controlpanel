import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { createTaskManager } from "./task/task-manager.js";
import { createTaskBus } from "./events/bus.js";
import { createRunner } from "./runner.js";
import { createTaskRouter } from "./routes/tasks.js";
import { createEventRouter } from "./routes/events.js";
import { createSandboxRouter } from "./routes/sandbox.js";
import { createStrategyRouter } from "./routes/strategy.js";
import { createCliRouter } from "./routes/cli.js";
import { createResearchRouter } from "./routes/research.js";
import { createEvidenceRouter } from "./routes/evidence.js";
import { createEvidenceGateRouter } from "./routes/evidence-gate.js";
import { loadPolicies } from "./policy/loader.js";
import { PolicyEngine } from "./policy/engine.js";
import { createDefaultRegistry, type SandboxRegistry } from "./sandbox/registry.js";
import { VerificationEngine } from "./verification/engine.js";
import { createDefaultWorkerRegistry, type WorkerRegistry } from "./worker/registry.js";
import { PiWorker } from "./worker/pi-worker.js";
import { McpServer, registerMcpRoutes } from "./mcp/server.js";
import { AcpServer, registerAcpRoutes } from "./acp/server.js";
import { getMemoryRetriever } from "./memory/retriever.js";
import { StyleKnowledgeBase } from "./rag/style-kb.js";
import { createResearchEngine } from "./research/engine.js";
import { createEvidenceModel } from "./evidence/model.js";
import { createEvidenceGate } from "./evidence/gate-api.js";
import { existsSync } from "node:fs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** §30 verification.sandbox.seatbelt.profile（缺省用 repo sandbox-profiles/verification-default.sb）
 *  設定化：CP_SEATBELT_PROFILE env 可直接指定（打包後 resource 路徑由 Rust 端傳入）。 */
function resolveSeatbeltProfile(policies: ReturnType<typeof loadPolicies>): string {
  const fromEnv = process.env.CP_SEATBELT_PROFILE;
  if (fromEnv) return fromEnv;
  const fromPolicy =
    policies.defaultPolicy.sandbox?.seatbelt?.profile ??
    policies.security?.sandbox?.seatbelt?.profile;
  return fromPolicy
    ? fileURLToPath(new URL(fromPolicy, import.meta.url).href).replace(/^file:\/\//, "")
    : `${REPO_ROOT}sandbox-profiles/verification-default.sb`;
}

export interface AppDeps {
  config: AppConfig;
  taskManager: ReturnType<typeof createTaskManager>;
  runner: ReturnType<typeof createRunner>;
  bus: ReturnType<typeof createTaskBus>;
  db: ReturnType<typeof createDb>;
  policies: ReturnType<typeof loadPolicies>;
  policyEngine: PolicyEngine;
  registry: SandboxRegistry;
  verificationEngine: VerificationEngine;
  workerRegistry: WorkerRegistry;
  memoryRetriever: ReturnType<typeof getMemoryRetriever>;
  styleKb: StyleKnowledgeBase;
  researchEngine: ReturnType<typeof createResearchEngine>;
  evidenceModel: ReturnType<typeof createEvidenceModel>;
  evidenceGate: ReturnType<typeof createEvidenceGate>;
}

export async function buildApp(opts: { config?: Partial<AppConfig> } = {}) {
  const config: AppConfig = { ...loadConfig(), ...opts.config };
  const db = createDb(config.dataDir);
  const taskManager = createTaskManager(db);
  const bus = createTaskBus();
  const policies = loadPolicies(config.policiesDir);
  const policyEngine = new PolicyEngine(policies, {
    phase: config.execution.phase,
    allowCloud: config.execution.allowCloud,
  });
  const workerRegistry = createDefaultWorkerRegistry({
    // llama 模式生成超時可經由 env 覆寫（預設 5 分鐘，7B CPU 生成 patch 需 30–120s）
    piWorker: new PiWorker({
      llamaTimeoutMs: Number(process.env.LLAMA_TIMEOUT_MS ?? 300_000),
    }),
  });
  const runner = createRunner(taskManager, bus, policyEngine, { workerRegistry });
  const registry = createDefaultRegistry({
    seatbeltProfile: resolveSeatbeltProfile(policies),
  });
  const verificationEngine = new VerificationEngine({
    registry,
    policy: {
      sandbox: policies.defaultPolicy.sandbox
        ? { mode: policies.defaultPolicy.sandbox.mode }
        : undefined,
      securityLevel: policies.security?.securityLevel ?? "medium",
    },
    record: (taskId, _attempt, r, sandboxMode) => {
      db.prepare(
        `INSERT INTO verification_results (id, task_id, verifier, status, output, sandbox_mode, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        taskId,
        r.verifier,
        r.status,
        r.output,
        sandboxMode,
        r.durationMs,
        new Date().toISOString(),
      );
    },
  });

  const memoryRetriever = getMemoryRetriever(`${config.dataDir}/.project-memory.db`);
  const styleKb = new StyleKnowledgeBase(db);
  const researchEngine = createResearchEngine({ memoryRetriever, styleKb });
  const evidenceModel = createEvidenceModel();
  evidenceModel.setResearchEngine(researchEngine);
  evidenceModel.setVerificationEngine(verificationEngine);
  const evidenceGate = createEvidenceGate();

  const app = Fastify({ logger: false });

  // §45.3 + §45.6：CORS — Tauri 2 webview 在 macOS 上以 `tauri://localhost` 載入前端，
  // fetch `http://127.0.0.1:<port>/api/...` 會被 WebKit 的 NetworkLoadChecker 視為 cross-origin
  // 並回 `validateResponse error / isAccessControl=1`。Control Plane 只 bind 127.0.0.1（loopback）
  // 且不接受任何非本機連線，因此 `origin: true`（reflect request Origin）等同「本機白名單」。
  await app.register(cors, { origin: true });

  // zod 驗證失敗 → 400（而非 500）
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation error", issues: err.issues });
    }
    const fe = err as FastifyError;
    reply.code(fe.statusCode ?? 500).send({ error: fe.message });
  });

  await app.register(createTaskRouter, { deps: { taskManager, runner } });
  await app.register(createEventRouter, { deps: { bus, runner } });
  await app.register(createSandboxRouter, { deps: { registry } });
  await app.register(createStrategyRouter, { deps: { taskManager, policyEngine } });
  await app.register(createCliRouter, {
    deps: { taskManager, policies, policyEngine, verificationEngine, workerRegistry },
  });
  await app.register(createResearchRouter, { deps: { researchEngine } });
  await app.register(createEvidenceRouter, { deps: { evidenceModel } });
  await app.register(createEvidenceGateRouter, { deps: { evidenceGate } });

  // §18/§19 協議層（Phase 6+ 預留；config.protocol 開關控制，預設 disabled）
  // 僅在明確啟用時建立內部 MCP Server（需完整 Control Plane 基礎設施）
  const legacyMcpServer = config.protocol.mcp.enabled
    ? new McpServer({
        policy: policyEngine,
        sandboxRegistry: registry,
        workspace: config.protocol.mcp.workspace,
      })
    : undefined;
  const acpServer = config.protocol.acp.enabled
    ? new AcpServer({ taskManager, runner, bus, policyEngine })
    : undefined;
  if (legacyMcpServer) registerMcpRoutes(app, legacyMcpServer);
  if (acpServer) registerAcpRoutes(app, acpServer);

  // 外部 MCP Server (tw-quant, yfinance, finmind) 為 subprocess-based，
  // 需要專門的 subprocess proxy 實作，暫不在這裡自動掛載
  // 可透過 MCP client 直接連接 stdio subprocess

  app.get("/health", async () => ({ status: "ok" }));

  return {
    app,
    deps: {
      config,
      db,
      taskManager,
      runner,
      bus,
      policies,
      policyEngine,
      registry,
      verificationEngine,
      workerRegistry,
      memoryRetriever,
      styleKb,
      researchEngine,
      evidenceModel,
      evidenceGate,
      acpServer,
    },
  };
}
