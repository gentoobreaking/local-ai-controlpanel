// Sandbox Registry + selectSandbox 測試（T012，§21.1 / §21.2）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRegistry } from "../../src/sandbox/registry.js";
import { selectSandbox } from "../../src/sandbox/select.js";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "../../src/sandbox/types.js";

class FakeSandbox implements Sandbox {
  runs: SandboxRunContext[] = [];
  constructor(
    public readonly name: Sandbox["name"],
    public available = true,
  ) {}

  async isAvailable() {
    return this.available;
  }

  async run(ctx: SandboxRunContext): Promise<SandboxRunResult> {
    this.runs.push(ctx);
    return { exitCode: 0, stdout: "fake", stderr: "", durationMs: 1, timedOut: false };
  }
}

function registryWith(fakes: FakeSandbox[]): SandboxRegistry {
  const r = new SandboxRegistry();
  for (const f of fakes) r.register(f.name, () => f);
  return r;
}

test("registry: register / get / 未註冊回 undefined", () => {
  const r = new SandboxRegistry();
  const sb = new FakeSandbox("seatbelt");
  r.register("seatbelt", () => sb);
  assert.equal(r.get("seatbelt"), sb);
  assert.equal(r.get("bwrap"), undefined);
});

test("default registry 註冊四種後端", () => {
  const r = new SandboxRegistry();
  r.register("bwrap", () => new FakeSandbox("bwrap"));
  r.register("seatbelt", () => new FakeSandbox("seatbelt"));
  r.register("shuru", () => new FakeSandbox("shuru"));
  r.register("docker", () => new FakeSandbox("docker"));
  assert.deepEqual(r.names().sort(), ["bwrap", "docker", "seatbelt", "shuru"]);
});

test("selectSandbox 第 1 步：task.sandboxMode 明確指定優先", async () => {
  const seatbelt = new FakeSandbox("seatbelt");
  const docker = new FakeSandbox("docker");
  const r = registryWith([seatbelt, docker]);
  const sb = await selectSandbox(r, { sandboxMode: "docker", risk: "low" }, {});
  assert.equal(sb, docker);
});

test("selectSandbox 第 1 步：指定模式不可用 → 跳過", async () => {
  const docker = new FakeSandbox("docker");
  const seatbelt = new FakeSandbox("seatbelt");
  const r = registryWith([docker, seatbelt]);
  const sb = await selectSandbox(r, { sandboxMode: "shuru", risk: "low" }, {});
  assert.equal(sb, seatbelt);
});

test("selectSandbox 第 2 步：policy.sandbox.mode 指定", async () => {
  const bwrap = new FakeSandbox("bwrap");
  const docker = new FakeSandbox("docker");
  const r = registryWith([bwrap, docker]);
  const sb = await selectSandbox(
    r,
    { risk: "low" },
    { sandbox: { mode: "bwrap" } },
  );
  assert.equal(sb, bwrap);
});

test("selectSandbox 第 3 步：high risk → shuru（若可用）", async () => {
  const shuru = new FakeSandbox("shuru");
  const docker = new FakeSandbox("docker");
  const r = registryWith([shuru, docker]);
  const sb = await selectSandbox(r, { risk: "high" }, {});
  assert.equal(sb, shuru);
});

test("selectSandbox 第 3 步：high risk 但 shuru 不可用 → 落到預設", async () => {
  const shuru = new FakeSandbox("shuru", false);
  const seatbelt = new FakeSandbox("seatbelt");
  const r = registryWith([shuru, seatbelt]);
  const sb = await selectSandbox(r, { risk: "high" }, {});
  assert.equal(sb, seatbelt);
});

test("selectSandbox 第 4 步：darwin 預設 seatbelt", async () => {
  const bwrap = new FakeSandbox("bwrap");
  const seatbelt = new FakeSandbox("seatbelt");
  const r = registryWith([bwrap, seatbelt]);
  const sb = await selectSandbox(r, { risk: "low" }, {});
  assert.equal(sb, process.platform === "darwin" ? seatbelt : bwrap);
});

test("selectSandbox 第 5 步：fallback docker", async () => {
  const docker = new FakeSandbox("docker");
  const r = registryWith([docker]);
  const sb = await selectSandbox(r, { risk: "low" }, {});
  assert.equal(sb, docker);
});

test("selectSandbox：全部不可用 → No sandbox available", async () => {
  const r = registryWith([
    new FakeSandbox("bwrap", false),
    new FakeSandbox("seatbelt", false),
    new FakeSandbox("shuru", false),
    new FakeSandbox("docker", false),
  ]);
  await assert.rejects(() => selectSandbox(r, { risk: "low" }, {}), /No sandbox available/);
});