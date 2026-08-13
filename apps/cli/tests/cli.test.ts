// acp CLI 整合測試：起一個臨時 Control Plane（127.0.0.1:0），以 ApiClient 執行指令。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApp } from "../../control-plane/src/server.js";
import { ApiClient } from "../src/api.js";
import { runCommand } from "../src/commands.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let baseUrl = "";
let dataDir = "";

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "acp-cli-test-"));
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
  return runCommand(argv, new ApiClient(baseUrl));
}

test("help 列出所有指令", async () => {
  const res = await fakeRun(["help"]);
  assert.equal(res.code, 0);
  assert.ok(res.lines.join("\n").includes("acp task run"));
  assert.ok(res.lines.join("\n").includes("acp sandbox check"));
});

test("task run 建立任務並回報狀態", async () => {
  const res = await fakeRun(["task", "run", "幫我列出 /etc/hosts 內容"]);
  assert.equal(res.code, 0);
  const out = res.lines.join("\n");
  assert.match(out, /任務已建立: TASK-\d+/);
  const id = /TASK-\d+/.exec(out)![0];
  return id;
});

test("task status / inspect / list / cancel 流程", async () => {
  await fakeRun(["task", "run", "測試任務 A"]);
  const listRes = await fakeRun(["task", "list"]);
  assert.equal(listRes.code, 0);
  const taskLine = listRes.lines.find((l) => l.startsWith("TASK-"));
  assert.ok(taskLine, "list 應包含至少一筆任務");
  const id = taskLine!.split("\t")[0]!;

  const statusRes = await fakeRun(["task", "status", id]);
  assert.equal(statusRes.code, 0);
  assert.match(statusRes.lines.join("\n"), new RegExp(`任務 ${id}: .*`));

  const inspectRes = await fakeRun(["task", "inspect", id]);
  assert.equal(inspectRes.code, 0);
  const detail = JSON.parse(inspectRes.lines.join("\n"));
  assert.equal(detail.id, id);

  const cancelRes = await fakeRun(["task", "cancel", id]);
  assert.equal(cancelRes.code, 0);
  assert.match(cancelRes.lines[0]!, /CANCELLED/);
});

test("task status 缺 id 回 exit 2", async () => {
  const res = await fakeRun(["task", "status"]);
  assert.equal(res.code, 2);
});

test("research / evidence：狀態查詢可運作", async () => {
  await fakeRun(["task", "run", "research 測試"]);
  const listRes = await fakeRun(["task", "list"]);
  const id = listRes.lines.find((l) => l.startsWith("TASK-"))!.split("\t")[0]!;
  const resR = await fakeRun(["research", id]);
  assert.equal(resR.code, 0);
  const resE = await fakeRun(["evidence", id]);
  assert.equal(resE.code, 0);
});

test("workers list / policy validate / sandbox check / strategy / logs / cloud usage", async () => {
  const w = await fakeRun(["workers", "list"]);
  assert.equal(w.code, 0);
  assert.ok(w.lines.join("\n").includes("pi-local"));

  const pv = await fakeRun(["policy", "validate"]);
  assert.equal(pv.code, 0);
  assert.ok(pv.lines.join("\n").includes("valid: true"));

  const sb = await fakeRun(["sandbox", "check"]);
  assert.equal(sb.code, 0);
  assert.ok(sb.lines.join("\n").includes("seatbelt"));

  await fakeRun(["task", "run", "logs 測試"]);
  const listRes = await fakeRun(["task", "list"]);
  const id = listRes.lines.find((l) => l.startsWith("TASK-"))!.split("\t")[0]!;

  const s = await fakeRun(["strategy", id]);
  assert.equal(s.code, 0);

  const lg = await fakeRun(["logs", id]);
  assert.equal(lg.code, 0);

  const cu = await fakeRun(["cloud", "usage"]);
  assert.equal(cu.code, 0);
  assert.ok(cu.lines.join("\n").includes("local_only"));
});

test("verify 回傳 sandbox 驗證結果（T012/T016 接入）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "acp-cli-verify-"));
  await fakeRun(["task", "run", "verify 測試", "--workspace", ws]);
  const listRes = await fakeRun(["task", "list"]);
  const id = listRes.lines.find((l) => l.startsWith("TASK-"))!.split("\t")[0]!;
  const res = await fakeRun(["verify", id, "--sandbox", "seatbelt"]);
  assert.equal(res.code, 0, `verify 失敗: ${res.lines.join("\n")}`);
  assert.ok(res.lines.join("\n").includes("git_diff"), "應包含 verifier 結果");
  rmSync(ws, { recursive: true, force: true });
});

test("不存在的任務回 exit 1", async () => {
  const res = await fakeRun(["task", "status", "NOPE-1"]);
  assert.equal(res.code, 1);
  assert.ok(res.lines.join("\n").includes("任務不存在"));
});

test("未知指令回 exit 2", async () => {
  const res = await fakeRun(["frobnicate"]);
  assert.equal(res.code, 2);
});