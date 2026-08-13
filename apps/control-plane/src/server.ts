import Fastify, { type FastifyError } from "fastify";
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

export interface AppDeps {
  config: AppConfig;
  taskManager: ReturnType<typeof createTaskManager>;
  runner: ReturnType<typeof createRunner>;
  bus: ReturnType<typeof createTaskBus>;
  db: ReturnType<typeof createDb>;
}

export async function buildApp(opts: { config?: AppConfig } = {}) {
  const config = opts.config ?? loadConfig();
  const db = createDb(config.dataDir);
  const taskManager = createTaskManager(db);
  const bus = createTaskBus();
  const runner = createRunner(taskManager, bus);
  const app = Fastify({ logger: false });

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
  await app.register(createSandboxRouter);
  await app.register(createStrategyRouter, { deps: { taskManager } });
  await app.register(createCliRouter, { deps: { taskManager } });

  app.get("/health", async () => ({ status: "ok" }));

  return { app, deps: { config, db, taskManager, runner, bus } };
}
