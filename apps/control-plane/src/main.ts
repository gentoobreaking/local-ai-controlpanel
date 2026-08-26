import { buildApp } from "./server.js";
import { loadConfig } from "./config.js";

// 載入 monorepo 根目錄 .env（Node 原生，零依賴）；無檔案則靜默跳過
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // .env 不存在 → 使用既有環境變數
}

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
