// Bubblewrap adapter 測試（T014，§21.2）。
// 參數模板測試所有平台皆可跑；isAvailable 需 macOS=false；真實隔離測試僅 Linux。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BwrapSandbox, buildBwrapArgs } from "../../src/sandbox/bwrap.js";

const linux = process.platform === "linux";
const sb = new BwrapSandbox();

const SYSTEM_DIRS = ["/usr", "/lib", "/bin", "/opt/homebrew"];

test("命令模板：ro-bind 系統目錄 + workspace 可寫 bind（§21.2）", () => {
  const ws = mkdtempSync(join(tmpdir(), "acp-bwrap-args-"));
  try {
    const args = buildBwrapArgs({ cwd: ws, mounts: [], network: false });
    const s = args.join(" ");
    for (const dir of SYSTEM_DIRS) {
      if (existsSync(dir)) {
        assert.ok(s.includes(`--ro-bind ${dir} ${dir}`), `缺少 ro-bind ${dir}`);
      }
    }
    assert.ok(s.includes(`--bind ${realpathSync(ws)} ${ws}`), "workspace 應可寫 bind");
    assert.ok(s.includes("--bind /tmp /tmp"));
    assert.ok(s.includes("--proc /proc --dev /dev"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("命令模板：--unshare-net/ipc/pid + --unshare-user + cap-drop ALL + die-with-parent", () => {
  const args = buildBwrapArgs({ cwd: tmpdir(), mounts: [], network: false });
  assert.ok(args.includes("--unshare-net"));
  assert.ok(args.includes("--unshare-ipc"));
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--unshare-user"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("--die-with-parent"));
});

test("命令模板：network=true 時不加 --unshare-net", () => {
  const args = buildBwrapArgs({ cwd: tmpdir(), mounts: [], network: true });
  assert.ok(!args.includes("--unshare-net"));
});

test("命令模板：mounts 依 writable 對應 bind/ro-bind", () => {
  const args = buildBwrapArgs({
    cwd: tmpdir(),
    mounts: [{ hostPath: "/usr", sandboxPath: "/sys-usr", writable: false }],
    network: false,
   });
  assert.ok(args.join(" ").includes("--ro-bind /usr /sys-usr"), "唯讀 mount 應為 --ro-bind");
  });

test("isAvailable：macOS/其他平台一律 false（不誤用）", async () => {
  if (linux) {
    assert.equal(typeof (await sb.isAvailable()), "boolean");
  } else {
    assert.equal(await sb.isAvailable(), false);
  }
});

test("run：spawn 失敗回傳 exitCode -1 而不 throw", async () => {
  if (linux && (await sb.isAvailable())) return; // Linux 由整合測試覆蓋
  const r = await sb.run({ command: ["true"], cwd: tmpdir() });
  assert.equal(r.exitCode, -1);
});

test("隔離：bwrap 內無網路（--unshare-net）", { skip: !linux }, async (t) => {
  if (!(await sb.isAvailable())) t.skip("無 bwrap");
  const r = await sb.run({
    command: ["sh", "-c", "curl -sS --max-time 5 http://127.0.0.1:1/ -o /dev/null 2>&1; echo $?"],
    cwd: tmpdir(),
    timeout: 15,
  });
  assert.notEqual(r.exitCode, 0, "無網路環境下 curl 應失敗");
});

test("隔離：sandbox 內執行 verifier 指令成功", { skip: !linux }, async (t) => {
  if (!(await sb.isAvailable())) t.skip("無 bwrap");
  const ws = mkdtempSync(join(tmpdir(), "acp-bwrap-npm-"));
  try {
    writeFileSync(
      join(ws, "package.json"),
      JSON.stringify({ name: "t", scripts: { test: "node -e \"require('node:assert').equal(1,1)\"" } }),
    );
    const r = await sb.run({ command: ["npm", "test"], cwd: ws, timeout: 30 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /1,1/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
