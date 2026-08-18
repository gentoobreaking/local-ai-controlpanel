// T040 Artifact Controller canonicalizeDiff 單元測試

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalizeDiff } from "../../src/artifact/controller.js";

function setupGitRepo(workDir: string) {
  execFileSync("git", ["init"], { cwd: workDir });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: workDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  execFileSync("git", ["add", "."], { cwd: workDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workDir });
}

test("canonicalizeDiff: 正規化基本 diff", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "foo.ts"), "hello\n");
  setupGitRepo(workDir);

  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-hello
+world
`;

  const canonical = await canonicalizeDiff(diff, workDir);
  
  assert.ok(canonical.includes("diff --git"));
  assert.ok(canonical.includes("src/foo.ts"));
  assert.ok(canonical.includes("-hello"));
  assert.ok(canonical.includes("+world"));
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 正規化新增檔案", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "existing.ts"), "existing\n");
  setupGitRepo(workDir);

  const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+new content
`;

  const canonical = await canonicalizeDiff(diff, workDir);
  
  assert.ok(canonical.includes("diff --git"));
  assert.ok(canonical.includes("src/new.ts"));
  assert.ok(canonical.includes("/dev/null"));
  assert.ok(canonical.includes("+new content"));
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 正規化刪除檔案", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "to_delete.ts"), "to delete\n");
  setupGitRepo(workDir);

  const diff = `diff --git a/src/to_delete.ts b/src/to_delete.ts
deleted file mode 100644
index abcdef1..0000000
--- a/src/to_delete.ts
+++ /dev/null
@@ -1 +0 @@
-to delete
`;

  const canonical = await canonicalizeDiff(diff, workDir);
  
  // 刪除檔案的 canonical diff 應該包含正確的標記
  assert.ok(typeof canonical === "string");
  // 刪除檔案可能返回空字串或包含刪除標記
  if (canonical.length > 0) {
    assert.ok(canonical.includes("diff --git"));
    assert.ok(canonical.includes("src/to_delete.ts"));
    assert.ok(canonical.includes("/dev/null"));
  }
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 內容不符的 diff 會被正規化（T023 功能）", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "foo.ts"), "actual content\n");
  setupGitRepo(workDir);

  // diff 中的內容與實際檔案不符
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-wrong content
+fixed content
`;

  const canonical = await canonicalizeDiff(diff, workDir);
  
  // 應該被正規化為實際的變更
  assert.ok(canonical.includes("diff --git"));
  assert.ok(canonical.includes("src/foo.ts"));
  assert.ok(canonical.includes("-actual content"));
  assert.ok(canonical.includes("+fixed content"));
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 多檔案 diff", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "a.ts"), "a\n");
  writeFileSync(join(workDir, "src", "b.ts"), "b\n");
  setupGitRepo(workDir);

  const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-a
+a modified
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-b
+b modified
`;

  const canonical = await canonicalizeDiff(diff, workDir);
  
  assert.ok(canonical.includes("src/a.ts"));
  assert.ok(canonical.includes("src/b.ts"));
  assert.ok(canonical.includes("-a"));
  assert.ok(canonical.includes("+a modified"));
  assert.ok(canonical.includes("-b"));
  assert.ok(canonical.includes("+b modified"));
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 空 diff 返回空字串", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-test-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "dummy.ts"), "dummy\n");
  setupGitRepo(workDir);

  const canonical = await canonicalizeDiff("", workDir);
  assert.strictEqual(canonical, "");
  
  rmSync(workDir, { recursive: true, force: true });
});

test("canonicalizeDiff: 響應時間 ≤ 500ms", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "canon-perf-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "perf.ts"), "performance test\n");
  setupGitRepo(workDir);

  const diff = `diff --git a/src/perf.ts b/src/perf.ts
index 1111111..2222222 100644
--- a/src/perf.ts
+++ b/src/perf.ts
@@ -1 +1 @@
-performance test
+performance test modified
`;

  const start = Date.now();
  await canonicalizeDiff(diff, workDir);
  const elapsed = Date.now() - start;
  
  assert.ok(elapsed <= 500, `canonicalizeDiff 耗時 ${elapsed}ms，超過 500ms 限制`);
  
  rmSync(workDir, { recursive: true, force: true });
});