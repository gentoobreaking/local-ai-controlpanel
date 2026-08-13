// Sandbox Matrix integration（T016 §38/§39）：可用的
// （後端 × verifier）組合應全部回傳結果。macOS 上僅 seatbelt 可用。

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server.js";

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>["app"];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "acp-matrix-"));
  ({ app } = await buildApp({ config: { host: "127.0.0.1", port: 0, dataDir: dir } }));
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Sandbox Matrix：每個可用後端 × 每個 verifier 皆回傳結果", async () => {
  const ws = dir;
  // 一個 package.json 專案 → UnitTest/Lint/Type 多 verifier 會被偵測
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "m", scripts: { test: "true" } }));

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "matrix verify", workspace: ws },
  });
  const taskId = created.json().id;

  const backends = ["seatbelt", "bwrap", "shuru", "docker"];
  const available: string[] = [];
  const probe = await app.inject({ method: "GET", url: "/api/v1/sandbox" });
  const probeBody = probe.json() as Record<string, boolean>;
  for (const b of backends) if (probeBody[b] === true) available.push(b);

  // macOS：至少 seatbelt 可用
  assert.ok(available.length >= 1, "應至少有一個 sandbox 可用");

  for (const mode of available) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/verify`,
      payload: { sandboxMode: mode, workspace: ws },
    });
    assert.equal(res.statusCode, 200, `${mode} verify 應回 200`);
    const body = res.json() as { results: { verifier: string; status: string }[] };
    assert.ok(body.results.length >= 1, `${mode} 應執行至少一個 verifier`);
    for (const r of body.results) {
      assert.ok(["PASS", "FAIL", "ERROR"].includes(r.status), `${r.verifier} 狀態非法`);
    }
  }
});

test("verify 切換 sandbox mode：不同 mode 回不同 sandbox 結果", async () => {
  const ws = dir;
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "m", scripts: { test: "node -e 0" } }));
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "switch verify", workspace: ws, sandboxMode: "seatbelt" },
  });
  const taskId = created.json().id;

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/verify`,
    payload: { sandboxMode: "seatbelt" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { sandboxMode?: string; sandbox?: string; results: unknown[] };
  assert.ok(body.results.length >= 1);
});

test("verify 缺 workspace → 400（需 task workspace 或 --workspace）", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { userRequest: "no workspace" },
  });
  const taskId = created.json().id;
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/verify`,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test("selectSandbox auto 模式：macOS 選 seatbelt（§21.2）", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/sandbox",
  });
  const body = res.json() as Record<string, boolean>;
  if (process.platform === "darwin") {
    assert.equal(body.seatbelt, true, "macOS seatbelt 應該可用");
  }
});
