// T033 CLI 完善：新指令（cp task create/list/show/...、run、baseline、report、
// db export、worker ping/models、--format、--watch、--config）整合測試。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../control-plane/src/server.js";
import { ApiClient } from "../src/api.js";
import { runCommand } from "../src/commands.js";
import { createDb } from "../../control-plane/src/db/index.js";

/** monorepo root（tests/ → apps/cli → apps → root） */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let baseUrl = "";
let dataDir = "";

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "acp-t033-test-"));
  app = await buildApp({ config: { host: "127.0.0.1", port: 0, dataDir } });
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.app.server.address();
  assert.ok(addr && typeof addr === "object");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app?.app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function fakeRun(argv: string[]) {
  return runCommand(argv, new ApiClient(baseUrl), { baseUrl });
}

async function createTask(request: string): Promise<string> {
  const res = await fakeRun(["task", "create", request]);
  assert.equal(res.code, 0, `create 失敗: ${res.lines.join("\n")}`);
  const m = /TASK-\d+/.exec(res.lines.join("\n"));
  assert.ok(m, `應回傳任務 id: ${res.lines.join("\n")}`);
  return m[0]!;
}

test("help 列出 T033 全部新指令 + 通用選項", async () => {
  const res = await fakeRun(["help"]);
  assert.equal(res.code, 0);
  const out = res.lines.join("\n");
  for (const cmd of [
    "cp task create",
    "cp task list",
    "cp task show",
    "cp task cancel",
    "cp task approve",
    "cp task retry",
    "cp run",
    "cp baseline run",
    "cp report generate",
    "cp db export",
    "cp worker ping",
    "cp worker models",
    "--format json|table|csv|markdown",
    "--watch",
    "--config",
  ]) {
    assert.ok(out.includes(cmd), `help 應包含 ${cmd}`);
  }
});

test("cp task create 建立任務（table + json 格式）", async () => {
  const t1 = await createTask("T033 create 測試");
  assert.match(t1, /^TASK-\d+$/);

  const json = await fakeRun(["task", "create", "T033 create json", "--json"]);
  assert.equal(json.code, 0);
  const obj = JSON.parse(json.lines.join("\n"));
  assert.equal(obj.userRequest, "T033 create json");
  assert.ok(obj.id);
});

test("cp task list：--status 過濾與四種輸出格式", async () => {
  const t1 = await createTask("T033 list A");
  await fakeRun(["task", "cancel", t1]);

  const cancelled = await fakeRun(["task", "list", "--status", "CANCELLED"]);
  assert.equal(cancelled.code, 0);
  assert.ok(cancelled.lines.join("\n").includes(t1), "filtered list 應含已取消任務");

  // --format json
  const j = await fakeRun(["task", "list", "--format", "json"]);
  assert.equal(j.code, 0);
  const arr = JSON.parse(j.lines.join("\n"));
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some((t: { id: string }) => t.id === t1));

  // --format csv
  const c = await fakeRun(["task", "list", "--format", "csv"]);
  assert.equal(c.code, 0);
  assert.match(c.lines[0]!, /^ID,STATUS/);
  assert.ok(c.lines.slice(1).some((l) => l.startsWith(`${t1},`)));

  // --format markdown
  const m = await fakeRun(["task", "list", "--format", "markdown"]);
  assert.equal(m.code, 0);
  assert.match(m.lines[0]!, /^\| ID \|/);

  // 預設 table（header 對齊）
  const tb = await fakeRun(["task", "list"]);
  assert.equal(tb.code, 0);
  assert.ok(tb.lines.some((l) => l.split(/\s+/)[0] === t1));

  // 無匹配狀態
  const none = await fakeRun(["task", "list", "--status", "NO_SUCH_STATUS"]);
  assert.equal(none.code, 0);
  assert.match(none.lines.join("\n"), /無 NO_SUCH_STATUS 任務/);
});

test("cp task show：狀態、attempt、evidence、patches 區塊", async () => {
  const id = await createTask("T033 show 測試");
  const res = await fakeRun(["task", "show", id]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  const out = res.lines.join("\n");
  assert.ok(out.includes(`任務 ${id}`), out);
  assert.ok(out.includes("attempt:"), out);
  assert.ok(out.includes("evidence:") || out.includes("證據"), out);
  assert.ok(out.includes("patches:"), out);

  const j = await fakeRun(["task", "show", id, "--json"]);
  assert.equal(j.code, 0);
  const obj = JSON.parse(j.lines.join("\n"));
  assert.equal(obj.task.id, id);
  assert.ok(Array.isArray(obj.patches));

  const missing = await fakeRun(["task", "show", "TASK-999"]);
  assert.equal(missing.code, 1);
  assert.ok(missing.lines.join("\n").includes("任務不存在"));
});

test("cp task approve：參數驗證與批准流程", async () => {
  const usage = await fakeRun(["task", "approve"]);
  assert.equal(usage.code, 2);

  const id = await createTask("T033 approve 測試");
  const res = await fakeRun(["task", "approve", id, "--actor", "t033-test", "--reason", "ok"]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  assert.ok(res.lines.join("\n").includes("已批准"));
});

test("cp task retry：取消後重試（狀態從 CANCELLED 重置再執行）", async () => {
  const id = await createTask("T033 retry 測試");
  await fakeRun(["task", "cancel", id]);
  const res = await fakeRun(["task", "retry", id]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  assert.match(
    res.lines.join("\n"),
    /→ (CREATED|ANALYZING|POLICY_CHECK|RESEARCH_REQUIRED|RESEARCHING)/,
    res.lines.join("\n"),
  );

  const nope = await fakeRun(["task", "retry", "TASK-XXX"]);
  assert.equal(nope.code, 1);
});

test("cp task watch：SSE 即時狀態（--timeout 自動結束）", async () => {
  const id = await createTask("T033 watch 測試");
  const res = await fakeRun(["task", "watch", id, "--timeout", "1"]);
  assert.ok(res.code === 0 || res.code === 1, res.lines.join("\n"));
  const out = res.lines.join("\n");
  assert.ok(out.includes("stage="), out);
  assert.ok(out.includes("未等至終態") || out.includes("完成:"), out);
});

test("cp db export：REST 匯出（json/csv/table）", async () => {
  const j = await fakeRun(["db", "export", "--format", "json"]);
  assert.equal(j.code, 0, j.lines.join("\n"));
  const obj = JSON.parse(j.lines.join("\n"));
  assert.ok(obj.tasks, "應包含 tasks 表");
  assert.ok(obj.patches, "應包含 patches 表");

  const c = await fakeRun(["db", "export", "--format", "csv"]);
  assert.equal(c.code, 0);
  assert.ok(c.lines.some((l) => l.includes("table: tasks")), c.lines.join("\n"));

  const t = await fakeRun(["db", "export", "--format", "table"]);
  assert.equal(t.code, 0);
  assert.ok(t.lines.some((l) => l.includes("table: tasks")));

  const single = await fakeRun(["db", "export", "--table", "tasks", "--format", "json"]);
  assert.equal(single.code, 0);
  const sObj = JSON.parse(single.lines.join("\n"));
  assert.ok(sObj.tasks);
  assert.ok(!sObj.patches, "指定 table 只匯出該表");
});

test("cp db export --db：直接讀本地 SQLite 檔案", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-t033-db-"));
  const dbPath = join(dir, "control-plane.db");
  const dp = createDb(dir);
  dp.prepare("INSERT INTO app_meta (key, value) VALUES ('test_key', 'ok')").run();
  dp.close();

  const res = await fakeRun(["db", "export", "--db", dbPath, "--format", "json"]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  const obj = JSON.parse(res.lines.join("\n"));
  assert.ok(obj.app_meta, "應包含 app_meta 表");
  assert.equal(obj.app_meta[0].value, "ok");

  const missing = await fakeRun(["db", "export", "--db", join(dir, "nope.db"), "--format", "json"]);
  assert.equal(missing.code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("cp worker ping：llama.cpp 未啟動 → exit 1", async () => {
  const res = await fakeRun(["worker", "ping"]);
  assert.equal(res.code, 1, res.lines.join("\n"));
  assert.ok(res.lines.join("\n").includes("失敗"), res.lines.join("\n"));
});

test("cp worker models：列出註冊模型（llama 未啟動仍有 registered）", async () => {
  const res = await fakeRun(["worker", "models"]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  const out = res.lines.join("\n");
  assert.ok(out.includes("pi-local"), out);

  const j = await fakeRun(["worker", "models", "--json"]);
  const obj = JSON.parse(j.lines.join("\n"));
  assert.ok(obj.registered.some((w: { worker: string }) => w.worker === "pi-local"));
});

test("cp policy validate --config：自訂政策路徑（本地驗證）", async () => {
  // 有效案例：repo 自帶 policies/（default.yaml 為 fail-fast 必備）
  const res = await fakeRun(["policy", "validate", "--config", join(REPO, "policies")]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  assert.ok(res.lines.join("\n").includes("valid: true"));

  // 無效案例：手寫無效 YAML
  const dir = mkdtempSync(join(tmpdir(), "acp-t033-policy-"));
  writeFileSync(join(dir, "default.yaml"), "not: [valid: yaml\n");
  const bad = await fakeRun(["policy", "validate", "--config", join(dir, "default.yaml")]);
  assert.equal(bad.code, 1);
  assert.ok(bad.lines.join("\n").includes("INVALID") || bad.lines.join("\n").includes("載入失敗"), bad.lines.join("\n"));
  rmSync(dir, { recursive: true, force: true });
});

test("cp run：單一任務 stub smoke test（baseline A）", async () => {
  const res = await fakeRun(["run", "T023", "--baseline", "A", "--mode", "stub"]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  assert.ok(res.lines.join("\n").includes("t030_baseline_abef"), res.lines.join("\n"));
});

test("cp report generate：T031 工具鏈（空結果目錄）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-t033-report-"));
  const outDir = join(dir, "reports");
  mkdirSync(outDir, { recursive: true });
  const res = await fakeRun([
    "report",
    "generate",
    "--results-dir", dir,
    "--output-dir", outDir,
  ]);
  assert.equal(res.code, 0, res.lines.join("\n"));
  assert.ok(res.lines.join("\n").includes("報告已生成"));
  const files = ["benchmark_report", ".csv", ".json"].map((s) =>
    readdirSync(outDir).some((f) => f.includes(s)),
  );
  assert.ok(files.every(Boolean), `reports 目錄應產出 md/csv/json: ${join(outDir)}`);
  rmSync(dir, { recursive: true, force: true });
});

test("未知 baseline 回 exit 2", async () => {
  const res = await fakeRun(["run", "T023", "--baseline", "Z"]);
  assert.equal(res.code, 2);
});