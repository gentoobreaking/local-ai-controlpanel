// Seatbelt adapter 測試（T013，§21.2 / §28.1）。
// 真實 sandbox-exec 整合測試（僅 macOS 執行；其他平台 skip）。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SeatbeltSandbox, buildSeatbeltProfile } from "../../src/sandbox/seatbelt.js";

const profilePath = new URL("../../../../sandbox-profiles/verification-default.sb", import.meta.url).pathname;
const sb = new SeatbeltSandbox({ profilePath });
const darwin = process.platform === "darwin";

// macOS 上 /bin 與 /usr/bin 可能為獨立目錄（部分機台缺 /bin/true 等）
const pick = (a: string, b: string) => (existsSync(a) ? a : b);
const TRUE_BIN = pick("/bin/true", "/usr/bin/true");
const SLEEP_BIN = pick("/bin/sleep", "/usr/bin/sleep");
const CURL_BIN = pick("/bin/curl", "/usr/bin/curl");
const SH_BIN = pick("/bin/sh", "/usr/bin/sh");

test("profile 存在且可被 sandbox-exec 載入（§28.1）", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const base = readFileSync(profilePath, "utf8");
  assert.ok(base.includes("(deny default)"));
  assert.ok(base.includes("(deny network*)"));
  const r = await sb.run({ command: [TRUE_BIN], cwd: tmpdir() });
  assert.equal(r.exitCode, 0, r.stderr);
});

test("isAvailable：macOS + sandbox-exec 存在 → true", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  assert.equal(await sb.isAvailable(), true);
});

test("sandbox 內執行 npm verifier 指令成功", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const ws = mkdtempSync(join(tmpdir(), "acp-seatbelt-npm-"));
  try {
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "t", scripts: { test: "node -e \"require('node:assert').equal(1,1)\"" } }));
    const r = await sb.run({ command: ["npm", "test"], cwd: ws, timeout: 30 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /1,1/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("隔離：寫入系統目錄 /usr 被拒（default-deny）", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const r = await sb.run({
    command: [SH_BIN, "-c", "touch /usr/acp-seatbelt-forbidden-$$ 2>&1; ls /usr/acp-seatbelt-forbidden-* 2>/dev/null | wc -l"],
    cwd: tmpdir(),
    timeout: 15,
  });
  // sandbox 內寫入被拒（macOS 26 上 deny 顯示為 Operation not permitted），
  // 檔案不存在（wc -l 最後一行為 0）
  const out = String(r.stdout);
  assert.match(out, /Operation not permitted/);
  assert.match(out.trim().split("\n").pop()!.trim(), /^0$/);
});

test("隔離：workspace（cwd）內可寫入", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const ws = mkdtempSync(join(tmpdir(), "acp-seatbelt-ws-"));
  try {
    const r = await sb.run({ command: ["touch", "written-in-sandbox.txt"], cwd: ws, timeout: 15 });
    assert.equal(r.exitCode, 0, r.stderr);
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(join(ws, "written-in-sandbox.txt")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("sandbox 內 network 被拒（deny network*）", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const r = await sb.run({ command: [CURL_BIN, "-sS", "--max-time", "5", "http://127.0.0.1:1/"], cwd: tmpdir(), timeout: 15 });
  assert.notEqual(r.exitCode, 0, "network 應被 sandbox 拒絕");
});

test("timeout：逾時被強制終止並標記 timedOut", async (t) => {
  if (!darwin) {
    t.skip("僅 macOS");
    return;
  }
  const started = Date.now();
  const r = await sb.run({ command: [SLEEP_BIN, "5"], cwd: tmpdir(), timeout: 1 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 4000, "應在 timeout 後迅速結束");
});

test("buildSeatbeltProfile：加入 workspace 寫入 + 可選網路", () => {
  const base = readFileSync(profilePath, "utf8");
  const p = buildSeatbeltProfile(base, "/tmp/acp-ws-123", { network: true });
  assert.ok(p.includes(`(subpath "/tmp/acp-ws-123")`));
  assert.ok(p.includes("(allow network*)"));
  assert.ok(!p.includes("(deny network*)"));
});