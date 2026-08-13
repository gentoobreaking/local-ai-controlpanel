import Fastify from "fastify";
import { loadConfig, type AppConfig } from "./config.js";

export async function buildApp(opts: { config?: AppConfig } = {}) {
  const config = opts.config ?? loadConfig();
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  return { app, deps: { config } };
}
