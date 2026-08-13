import { buildApp } from "./server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const { app } = await buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(
    `[control-plane] listening on http://${config.host}:${config.port} (data: ${config.dataDir})`,
  );
} catch (err) {
  console.error("[control-plane] failed to start:", err);
  process.exit(1);
}
