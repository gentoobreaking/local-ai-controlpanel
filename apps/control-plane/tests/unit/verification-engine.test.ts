// Verification Engine 測試（T012，§21 / Rule 8）。

import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SandboxRegistry } from "../../src/sandbox/registry.js";
import type { Sandbox, SandboxRunContext, SandboxRunResult } from "../../src/sandbox/types.js";
import { VerificationEngine } from "../../src/verification/engine.js";
import { DEFAULT_VERIFIERS } from "../../src/verification/verifiers.js";
import type { VerificationContext } from "../../src/verification/types.js";

const execFileAsync = promisify(execFileCb);

function readPackageJson(path: string): string {
  return readFileSync(path, "utf8");
}

/** 假 sandbox：記錄所有命令（證明 engine 一律走 sandbox.run，Rule 8） */
class RecordingSandbox implements Sandbox {
  runs: { ctx: SandboxRunContext; executed: boolean }[] = [];
  constructor(
    public readonly name: Sandbox["name"],
    private readonly execute: boolean,
  ) {}

  async isAvailable() {
    return true;
  }

  async run(ctx: SandboxRunContext): Promise<SandboxRunResult> {
    if (!this.execute) {
      this.runs.push({ ctx, executed: false });
      return { exitCode: 0, stdout: "(fake sandbox: not executed)", stderr: "", durationMs: 1, timedOut: false };
    }
    const started = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync(ctx.command[0]!, ctx.command.slice(1), {
        cwd: ctx.cwd,
        timeout: (ctx.timeout ?? 120) * 1000,
      });
      this.runs.push({ ctx, executed: true });
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - started, timedOut: false };
    } catch (err) {
      const e = err as { code?: number; stderr?: string; message: string };
      this.runs.push({ ctx, executed: true });
      return {
        exitCode: e.code ?? 1,
        stdout: "",
        stderr: String(e.stderr ?? e.message),
        durationMs: Date.now() - started,
        timedOut: e.code === undefined,
      };
    }
  }
}

let workspaces: string[] = [];
const sandbox = new RecordingSandbox("seatbelt", false);
const registry = new SandboxRegistry();
registry.register("seatbelt", () => sandbox);

function mkWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-verif-"));
  workspaces.push(dir);
  return dir;
}

function makeCtx(ws: string, over: Partial<VerificationContext> = {}): VerificationContext {
  const hasPackageJson = existsSync(join(ws, "package.json"));
  let packageScripts: string[] = [];
  if (hasPackageJson) {
    const pkg = JSON.parse(readPackageJson(join(ws, "package.json")));
    packageScripts = Object.keys(pkg.scripts ?? {});
  }
  return {
    taskId: "TASK-777",
    attempt: 1,
    workspaceDir: ws,
    repo: {
      path: ws,
      languages: hasPackageJson ? ["typescript"] : [],
      frameworks: [],
      hasPackageJson,
      hasTsConfig: existsSync(join(ws, "tsconfig.json")),
      hasGoMod: existsSync(join(ws, "go.mod")),
      hasCargoToml: existsSync(join(ws, "Cargo.toml")),
      hasPyProject: existsSync(join(ws, "pyproject.toml")),
      packageScripts,
    },
    task: { risk: "low", sandboxMode: "seatbelt" },
    ...over,
  };
}

const recorded: { result: { verifier: string; status: string }; mode: string; taskId: string }[] = [];
const engine = new VerificationEngine({
  registry,
  policy: {},
  record(taskId, _attempt, r, mode) {
    recorded.push({ result: { verifier: r.verifier, status: r.status }, mode, taskId });
  },
});

before(() => {
  const ts = mkWorkspace();
  writeFileSync(
    join(ts, "package.json"),
    JSON.stringify({
      name: "fixture-ts",
      scripts: {
        test: "node --test tests/",
        lint: "node -e \"console.log('lint ok')\"",
        build: "node -e \"console.log('build ok')\"",
      },
    }),
  );
  writeFileSync(join(ts, "tsconfig.json"), "{}");
  mkdirSync(join(ts, "tests"));
  writeFileSync(join(ts, "tests", "x.test.js"), "const assert = require('node:assert');\nassert.equal(1, 1);\n");

  const fail = mkWorkspace();
  writeFileSync(
    join(fail, "package.json"),
    JSON.stringify({ name: "fixture-fail", scripts: { test: "node -e \"process.exit(3)\"" } }),
  );
});

after(() => {
  for (const w of workspaces) rmSync(w, { recursive: true, force: true });
});

test("detect：ts fixture → git_diff / unit_test / build / lint（typecheck 需 tsc 安裝）", async () => {
  const ws = workspaces[0]!;
  const ctx = makeCtx(ws);
  const detected = new Set<string>();
  for (const p of DEFAULT_VERIFIERS) {
    if (await p.detect(ctx)) detected.add(p.id);
  }
  assert.deepEqual([...detected].sort(), ["build", "git_diff", "lint", "unit_test"]);
});

test("run：所有適用 verifier 一律透過 sandbox.run（Rule 8，不直接 exec）", async () => {
  const ctx = makeCtx(workspaces[0]!);
  const results = await engine.verify(ctx, DEFAULT_VERIFIERS);
  assert.ok(results.length >= 4, `應至少 4 個 verifier，實際 ${results.length}`);
  for (const r of results) {
    assert.equal(r.status, "PASS");
    assert.ok(recorded.some((x) => x.result.verifier === r.verifier));
    assert.ok(recorded.some((x) => x.mode === "seatbelt"));
  }
  // Rule 8：命令有進 sandbox.run，且執行 sandbox 為 seatbelt（非 host 直接跑）
  const commands = sandbox.runs.map((x) => x.ctx.command[0]);
  assert.ok(commands.includes("git"));
  assert.ok(commands.includes("npm"));
  assert.ok(sandbox.runs.every((x) => x.ctx.cwd === workspaces[0]));
});

test("exit code 非 0 → FAIL（sandbox 真實執行）", async () => {
  const execSandbox = new RecordingSandbox("docker", true);
  const r2 = new SandboxRegistry();
  r2.register("docker", () => execSandbox);
  const e2 = new VerificationEngine({
    registry: r2,
    policy: {},
    record() {},
  });
  const results = await e2.verify(makeCtx(workspaces[1]!, { task: { risk: "low", sandboxMode: "docker" } }), DEFAULT_VERIFIERS);
  const unit = results.find((r) => r.verifier === "unit_test");
  assert.ok(unit, "unit_test 應執行");
  assert.equal(unit!.status, "FAIL");
  assert.ok(execSandbox.runs.some((x) => x.ctx.command[0] === "npm"));
});

test("record 寫入 sandbox_mode", async () => {
  recorded.length = 0;
  const ctx = makeCtx(workspaces[0]!);
  await engine.verify(ctx, DEFAULT_VERIFIERS);
  assert.ok(recorded.length > 0);
  assert.ok(recorded.every((x) => x.mode === "seatbelt"));
});

test("無可用 sandbox → throw（rule-8 不降級為 host 執行）", async () => {
  const dead = new SandboxRegistry();
  dead.register("seatbelt", () => ({ name: "seatbelt" as const, async isAvailable() { return false; }, async run() { throw new Error("never"); } }));
  const e3 = new VerificationEngine({ registry: dead, policy: {}, record() {} });
  await assert.rejects(
    () => e3.verify(makeCtx(workspaces[0]!), DEFAULT_VERIFIERS),
    /No sandbox available/,
  );
});