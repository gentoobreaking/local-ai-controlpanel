// Shuru（MicroVM）adapter 測試（T015，§21.2 / §30）。
// 僅 shuru CLI 未安裝時 isAvailable=false；選擇邏輯 fallback 測試用 registry mock。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ShuruSandbox, buildShuruArgs } from "../../src/sandbox/shuru.js";
import { selectSandbox } from "../../src/sandbox/select.js";
import { SandboxRegistry } from "../../src/sandbox/registry.js";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "../../src/sandbox/types.js";

const sb = new ShuruSandbox();

test("命令模板：--image/--memory/--cpus/--network false/--snapshot/--volume（§30）", () => {
  const ws = mkdtempSync(join(tmpdir(), "acp-shuru-args-"));
  try {
    const args = buildShuruArgs({ command: ["true"], cwd: ws, mounts: [], network: false });
    const s = args.join(" ");
    assert.ok(s.includes("--image shuru/alpine:3.20"));
    assert.ok(s.includes("--memory 512MiB"));
    assert.ok(s.includes("--cpus 1"));
    assert.ok(s.includes("--network false"));
    assert.ok(s.includes("--snapshot"));
    assert.ok(s.includes(`--volume ${realpathSync(ws)}:${realpathSync(ws)}:rw`));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("命令模板：network=true → --network true；mounts 加唯讀 volume", () => {
  const ws = tmpdir();
  const args = buildShuruArgs({
    command: ["true"],
    cwd: ws,
    mounts: [{ hostPath: "/etc", sandboxPath: "/host-etc", writable: false }],
    network: true,
  });
  const i = args.indexOf("--network");
  assert.equal(args[i + 1], "true");
  assert.ok(args.join(" ").includes("--volume /etc:/host-etc:ro"));
});

test("isAvailable：未安裝 shuru → false", async () => {
  if (existsSync("/usr/bin/shuru") || existsSync("/opt/homebrew/bin/shuru")) {
    assert.equal(typeof (await sb.isAvailable()), "boolean");
  } else {
    assert.equal(await sb.isAvailable(), false);
  }
});

test("run：spawn 失敗回傳 exitCode -1 而不 throw", async () => {
  const r = await sb.run({ command: ["echo", "hi"], cwd: tmpdir() });
  assert.equal(r.exitCode, -1);
  assert.equal(r.timedOut, false);
});

test("selectSandbox step 3：high-risk task 且 shuru 不在 → fallback 到預設 sandbox", async () => {
  const registry = new SandboxRegistry();
  // shuru 註冂但不可用
  let shuruRan = false;
  registry.register("shuru", () => ({
    name: "shuru",
    async isAvailable() {
      shuruRan = true;
      return false;
    },
    async run() {
      throw new Error("never");
    },
  }));
  // 預設 backend（macOS seatbelt）也註冂
  registry.register("seatbelt", () => ({
    name: "seatbelt",
    async isAvailable() {
      return true;
    },
    async run(_: SandboxRunContext): Promise<SandboxRunResult> {
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    },
  }));
  const picked = await selectSandbox(
    registry,
    { sandboxMode: "auto", risk: "high" },
    { sandbox: { mode: "auto" } },
  );
  assert.ok(picked);
  assert.equal(picked.name, "seatbelt", "shuru 不可用應 fallback");
  assert.equal(shuruRan, true, "應嘗試 shuru");
});
