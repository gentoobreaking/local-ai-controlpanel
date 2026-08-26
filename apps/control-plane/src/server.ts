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
import { createCliRouter } from "./routes/cli.js";
import { buildVerificationContext } from "./verification/context.js";
import { DEFAULT_VERIFIERS } from "./verification/verifiers.js";
import { createStrategyRouter } from "./routes/strategy.js";
import { createResearchRouter } from "./routes/research.js";
import { createEvidenceRouter } from "./routes/evidence.js";
import { createEvidenceGateRouter } from "./routes/evidence-gate.js";
import { createVerifyGateRouter } from "./routes/verify-gate.js";
import { createArtifactRouter } from "./routes/artifact.js";
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
import { createArtifactController } from "./artifact/controller.js";
import { existsSync } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";

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
    model: process.env.LLAMA_MODEL,
  });
  const registry = createDefaultRegistry({
    seatbeltProfile: resolveSeatbeltProfile(policies),
  });
  // T017/T040/T012 整合層：三個 hook 皆在 runner 之後建立依賴 → 用延遲綁定接線。
  let researchTrigger: ((taskId: string, query: string, workspace?: string) => void) | null = null;
  let artifactTrigger: ((taskId: string, workspace?: string) => void) | null = null;
  let verifyingTrigger: ((taskId: string, workspace?: string) => void) | null = null;
  const runner = createRunner(taskManager, bus, policyEngine, {
    workerRegistry,
    onResearchRequired: (taskId, query, workspace) => researchTrigger?.(taskId, query, workspace),
    onArtifactValidation: (taskId, workspace) => artifactTrigger?.(taskId, workspace),
    onVerificationRequired: (taskId, workspace) => verifyingTrigger?.(taskId, workspace),
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
  // 綁定：研究完成 → reportResearch 推進 pipeline（COMPLETE/PARTIAL/FAILED 皆回報）。
  researchTrigger = (taskId, query, workspace) => {
    // 從任務描述粗略偵測語言（StyleKB 搜尋需要精確 language 過濾）
    const lang = /\.py\b|python/i.test(query)
      ? "python"
      : /\.(ts|tsx)\b|typescript/i.test(query)
        ? "typescript"
        : /\.(go)\b|golang/i.test(query)
          ? "go"
          : "unknown";
    // 專案名 = workspace 路徑最後一段（與 PiWorker T032 慣例一致）
    const projectName = workspace?.split("/").filter(Boolean).pop();
    void researchEngine
      .research({ taskId, query, language: lang, project: projectName, topK: 5 })
      .then((result) => {
        const sources = new Set(result.evidence.map((e) => e.type));
        const summary = {
          facts: result.evidence.length,
          sourcesCount: sources.size,
          // research engine 的 evidence 型別（memory/style-kb/external）皆非官方文檔來源
          officialSources: 0,
        };
        const stage1 = result.evidence.length > 0 ? "COMPLETE" : "PARTIAL";
        runner.reportResearch(taskId, summary, stage1);
      })
      .catch(() => runner.reportResearch(taskId, { facts: 0, sourcesCount: 0, officialSources: 0 }, "FAILED"));
  };
  const evidenceModel = createEvidenceModel();
  evidenceModel.setResearchEngine(researchEngine);
  evidenceModel.setVerificationEngine(verificationEngine);
  const evidenceGate = createEvidenceGate();
  const artifactController = createArtifactController({ db });

  // T011/T040 + T012 整合層：ARTIFACT_VALIDATION → 驗證並套用 patch → VERIFYING → 沙箱驗證。
  artifactTrigger = (taskId: string, workspace?: string) => {
      void (async () => {
        try {
          const row = db
            .prepare(
              "SELECT id, attempt, diff FROM patches WHERE task_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1",
            )
            .get(taskId) as { id: string; attempt: number; diff: string } | undefined;
          if (!row || !workspace) {
            runner.reportArtifactValidation(taskId, false, "no proposed patch or workspace missing");
            return;
          }
          const normalized = await artifactController.normalizeExistingFiles(row.diff, workspace);
          const decision = artifactController.validate({ diff: normalized }, policies.defaultPolicy.artifact!);
          if (decision.verdict !== "APPROVED") {
            runner.reportArtifactValidation(
              taskId,
              false,
              `artifact policy: ${decision.violations.map((v) => `${v.file}:${v.rule}`).join(", ")}`,
            );
            return;
          }
          await artifactController.apply(
            { taskId, attempt: row.attempt, diff: normalized, workspaceDir: workspace },
            policies.defaultPolicy.artifact!,
          );
          runner.reportArtifactValidation(taskId, true);
        } catch (err) {
          runner.reportArtifactValidation(taskId, false, (err as Error).message.split("\n")[0]);
        }
      })();
  };
  verifyingTrigger = (taskId: string, workspace?: string) => {
      void (async () => {
        try {
          if (!workspace) {
            runner.reportVerificationResult(taskId, false, "workspace missing for verification");
            return;
          }
          const task = taskManager.getRow(taskId)!;
          const ctx = {
            taskId,
            attempt: task.attempt,
            workspaceDir: workspace,
            repo: buildVerificationContext(workspace),
            task: {
              risk: (task.risk as "low" | "medium" | "high") ?? undefined,
              sandboxMode: task.sandboxMode ?? undefined,
            },
          };
          const { results } = await verificationEngine.verify(ctx, DEFAULT_VERIFIERS);
          const allPass = results.length > 0 && results.every((r) => r.status === "PASS");
          const output = results.map((r) => `${r.verifier}=${r.status}`).join("; ") + "\n" + results.map((r) => r.output ?? "").join("\n");
          runner.reportVerificationResult(taskId, allPass, output);
        } catch (err) {
          runner.reportVerificationResult(taskId, false, (err as Error).message.split("\n")[0] ?? "");
        }
      })();
  };
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
  await app.register(createArtifactRouter, { deps: { artifactController } });
  await app.register(createResearchRouter, { deps: { researchEngine } });
  await app.register(createEvidenceRouter, { deps: { evidenceModel } });
  await app.register(createEvidenceGateRouter, { deps: { evidenceGate } });
  await app.register(createVerifyGateRouter, { deps: { evidenceGate, evidenceModel } });

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

  // §18/§19 外部 MCP Server (tw-quant, yfinance, finmind) subprocess 掛載
  const externalMcpProcesses = new Map<string, ChildProcess>();

  async function startExternalMcpServers() {
    const mcpCfg = config.protocol.mcpServers;

    // 1. tw-quant-mcp (Go binary, stdio)
    if (mcpCfg.twQuant.enabled && existsSync(mcpCfg.twQuant.path)) {
      const proc = spawn(mcpCfg.twQuant.path, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MCP_TRANSPORT: "stdio" },
      });
      proc.on("error", (e) => console.error("[tw-quant-mcp] spawn error:", e));
      proc.on("exit", (code) => console.warn(`[tw-quant-mcp] exited with code ${code}`));
      externalMcpProcesses.set("tw-quant-mcp", proc);
      console.log("[MCP] Started tw-quant-mcp (stdio)");
    }

    // 2. yfinance-mcp (uvx)
    if (mcpCfg.yfinance.enabled) {
      const proc = spawn("uvx", ["yfmcp@latest"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      proc.on("error", (e) => console.error("[yfinance-mcp] spawn error:", e));
      externalMcpProcesses.set("yfinance-mcp", proc);
      console.log("[MCP] Started yfinance-mcp (stdio)");
    }

    // 3. finmind-mcp (uvx + token)
    if (mcpCfg.finmind.enabled && process.env.FINMIND_TOKEN) {
      const proc = spawn("uvx", ["finmind-mcp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FINMIND_TOKEN: process.env.FINMIND_TOKEN },
      });
      proc.on("error", (e) => console.error("[finmind-mcp] spawn error:", e));
      externalMcpProcesses.set("finmind-mcp", proc);
      console.log("[MCP] Started finmind-mcp (stdio)");
    }

    // JSON-RPC stdio proxy routes
    for (const [name, proc] of externalMcpProcesses) {
      app.post(`/mcp/${name}`, async (req, reply) => {
        return new Promise((resolve, reject) => {
          const body = req.body as Record<string, unknown> | undefined;
          const id = (body?.id as string) ?? randomUUID();
          const request = { ...body, id, jsonrpc: "2.0" };

          const onData = (data: Buffer) => {
            try {
              const lines = data.toString().trim().split("\n");
              for (const line of lines) {
                const msg = JSON.parse(line);
                if (msg.id === id) {
                  proc.stdout?.off("data", onData);
                  resolve(reply.send(msg));
                  return;
                }
              }
            } catch {
              // ignore parse errors, wait for next chunk
            }
          };

          proc.stdout?.on("data", onData);

          // 30s timeout
          setTimeout(() => {
            proc.stdout?.off("data", onData);
            reject(new Error("MCP request timeout"));
          }, 30000);

          proc.stdin?.write(JSON.stringify(request) + "\n");
        });
      });
    }

    console.log(`[MCP] External servers started: ${Array.from(externalMcpProcesses.keys()).join(", ") || "none"}`);
  }

  await startExternalMcpServers();

  // 清理外部 MCP 進程
  app.addHook("onClose", async () => {
    for (const [name, proc] of externalMcpProcesses) {
      proc.kill("SIGTERM");
      console.log(`[MCP] Stopped ${name}`);
    }
  });

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
