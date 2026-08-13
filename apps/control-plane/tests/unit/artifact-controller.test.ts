// Artifact Controller 測試（T011）：三種違規阻擋 + apply/rollback 真實 git repo。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDb } from "../../src/db/index.js";
import { createTaskManager } from "../../src/task/task-manager.js";
import { loadPolicies } from "../../src/policy/loader.js";
import { createArtifactController, ArtifactViolation, diffFiles } from "../../src/artifact/controller.js";

const policiesDir = new URL("../../../../policies", import.meta.url).pathname;
const artifactPolicy = loadPolicies(policiesDir).defaultPolicy.artifact!;

let workDir = "";
let dataDir = "";
let controller: ReturnType<typeof createArtifactController>;
let taskId = "";
let taskId2 = "";
let lastPatchId = "";

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function makeDiff(repo: string, path?: string): string {
  return git(repo, "diff", ...(path ? ["--", path] : []));
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "acp-artifact-repo-"));
  git(workDir, "init", "-q");
  git(workDir, "config", "user.email", "test@acp.local");
  git(workDir, "config", "user.name", "acp test");
  mkdirSync(join(workDir, "src"), { recursive: true });
  mkdirSync(join(workDir, "secrets"), { recursive: true });
  mkdirSync(join(workDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(workDir, "src", "foo.ts"), "hello\n");
  writeFileSync(join(workDir, "package-lock.json"), "{}\n");
  writeFileSync(join(workDir, ".env"), "SECRET=0\n");
  writeFileSync(join(workDir, "secrets", "key.pem"), "x\n");
  writeFileSync(join(workDir, "node_modules", "pkg", "index.js"), "x\n");
  git(workDir, "add", "-A");
  git(workDir, "commit", "-qm", "init");

  dataDir = mkdtempSync(join(tmpdir(), "acp-artifact-db-"));
  const tm = createTaskManager(createDb(dataDir));
  taskId = tm.create({ userRequest: "artifact test 900" }).id;
  taskId2 = tm.create({ userRequest: "artifact test 901" }).id;
  controller = createArtifactController({ db: tm.db });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("diffFiles 解析 git diff 檔案清單", () => {
  writeFileSync(join(workDir, "src", "foo.ts"), "hello world\n");
  const files = diffFiles(makeDiff(workDir));
  assert.deepEqual(files, ["src/foo.ts"]);
});

test("forbidden（.env）→ ArtifactViolation", () => {
  writeFileSync(join(workDir, ".env"), "SECRET=1\n");
  const diff = makeDiff(workDir, ".env");
  assert.throws(
    () => controller.validate({ diff, files: ["src/foo.ts", ".env"] }, artifactPolicy),
    (e: unknown) => e instanceof ArtifactViolation && e.name === "ArtifactViolation",
  );
  // diff-based 判斷同樣被擋（validate 會 parse diff）
  assert.throws(() => controller.validate({ diff }, artifactPolicy), ArtifactViolation);
});

test("forbidden（secrets/**）→ ArtifactViolation", () => {
  writeFileSync(join(workDir, "secrets", "key.pem"), "xx\n");
  const diff = makeDiff(workDir, "secrets/key.pem");
  assert.throws(() => controller.validate({ diff }, artifactPolicy), ArtifactViolation);
});

test("非 allowed 路徑（node_modules/**）→ UnauthorizedModification", () => {
  writeFileSync(join(workDir, "node_modules", "pkg", "index.js"), "xx\n");
  const diff = makeDiff(workDir, "node_modules/pkg/index.js");
  assert.throws(
    () => controller.validate({ diff }, artifactPolicy),
    (e: unknown) => e instanceof ArtifactViolation && /不在 allowed/.test(e.message),
  );
});

test("readonly（package-lock.json）→ ReadonlyViolation", () => {
  writeFileSync(join(workDir, "package-lock.json"), "{ changed: true }\n");
  const diff = makeDiff(workDir, "package-lock.json");
  assert.throws(
    () => controller.validate({ diff }, artifactPolicy),
    (e: unknown) => e instanceof ArtifactViolation && /readonly/.test(e.message.toLowerCase()),
  );
});

test("apply：allowed 內檔案套用成功並寫入 patches 表", async () => {
  // 清掉前面測試的修改（.env / key.pem / node_modules / package-lock）
  git(workDir, "checkout", "--", ".");
  writeFileSync(join(workDir, "src", "foo.ts"), "hello world 2\n");
  const diff = makeDiff(workDir, "src/foo.ts");
  // 先復原再套用（確保 git apply 乾淨）
  git(workDir, "checkout", "--", "src/foo.ts");
  const applied = await controller.apply(
    { taskId, attempt: 1, diff, workspaceDir: workDir },
    artifactPolicy,
  );
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.files, ["src/foo.ts"]);
  assert.equal(readFileSync(join(workDir, "src", "foo.ts"), "utf8"), "hello world 2\n");
  assert.notEqual(applied.patchId, "");
  lastPatchId = applied.patchId;
});

test("rollback：回復原內容並標記 rolled_back", async () => {
  writeFileSync(join(workDir, "src", "foo.ts"), "line3\n");
  const diff = makeDiff(workDir, "src/foo.ts");
  git(workDir, "checkout", "--", "src/foo.ts");
  const applied = await controller.apply(
    { taskId: taskId2, attempt: 1, diff, workspaceDir: workDir },
    artifactPolicy,
  );
  await controller.rollback(applied.patchId);
  assert.equal(readFileSync(join(workDir, "src", "foo.ts"), "utf8"), "hello\n");
  // 重複 rollback → 錯誤
  await assert.rejects(() => controller.rollback(applied.patchId), /不可 rollback/);
});

test("apply 前 git apply --check 失敗（diff 與 repo 不一致）→ 拒絕", async () => {
  // 內容與 repo 實際狀態（hello）不符的 diff
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1 +1 @@",
    "-not-the-real-content",
    "+anything",
  ].join("\n") + "\n";
  await assert.rejects(
    () => controller.apply({ taskId, attempt: 1, diff, workspaceDir: workDir }, artifactPolicy),
    ArtifactViolation,
  );
  assert.ok(!existsSync(join(workDir, "src", "bar.ts")), "不得套用任何檔案");
  assert.equal(readFileSync(join(workDir, "src", "foo.ts"), "utf8"), "hello\n");
});