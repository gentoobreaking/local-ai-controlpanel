// acp CLI 入口（spec §29）。

import { ApiClient } from "./api.js";
import { runCommand } from "./commands.js";

const baseUrl = process.env.ACP_URL ?? "http://127.0.0.1:3001";
const client = new ApiClient(baseUrl);

const res = await runCommand(process.argv.slice(2), client);
for (const line of res.lines) process.stdout.write(line + "\n");
process.exit(res.code);
