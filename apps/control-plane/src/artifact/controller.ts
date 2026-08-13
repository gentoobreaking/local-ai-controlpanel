// Artifact Controller（spec §20）。
// Patch 不能直接寫 filesystem：
//   Worker → Proposed Patch → Artifact Controller → Policy Validation
//   → Git Diff Validation → Filesystem Apply
// 所有 Worker（含未來 Cloud Worker）共用同一 Artifact Policy（Rule 2）。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ArtifactPolicy } from "../policy/schemas.js";
import type { ArtifactDecision } from "../policy/types.js";

const execFileAsync = promisify(execFile);

/** 違規類型（§20 python 範例的 TS 版） */
export class ArtifactViolation extends Error {
  constructor(
    public readonly file: string,
    public readonly rule: ArtifactDecision["violations"][number]["rule"],
  ) {
    super(
      rule === "forbidden"
        ? `ArtifactViolation: ${file} 命中 forbidden（§20）`
        : rule === "readonly"
          ? `ReadonlyViolation: ${file} 為 readonly，拒絕修改（§20）`
          : `UnauthorizedModification: ${file} 不在 allowed 路徑（§20）`,
    );
    this.name =
      rule === "readonly"
        ? "ReadonlyViolation"
        : rule === "forbidden"
          ? "ArtifactViolation"
          : "UnauthorizedModification";
  }
}

export interface Patch {
  taskId: string;
  attempt: number;
  /** git unified diff（`diff --git a/... b/...`） */
  diff: string;
  /** 套用目標：git repo 的工作目錄（worker workspace） */
  workspaceDir: string;
}

export interface AppliedPatch {
  patchId: string;
  taskId: string;
  attempt: number;
  files: string[];
  status: "applied";
  appliedAt: string;
}

export interface PatchRow {
  id: string;
  task_id: string;
  attempt: number;
  path: string;
  status: string;
  diff: string;
  workspace_dir: string | null;
  created_at: string;
}

/** 從 git diff 解析被觸及的檔案清單（git diff --name-only 的輕量替代） */
export function diffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      if (m?.[1]) files.push(m[1].trim());
    }
  }
  return files;
}

export interface ArtifactControllerDeps {
  db: {
    prepare(sql: string): {
      run(...args: unknown[]): void;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
  };
}

/**
 * validate：Policy Validation + Git Diff Validation。
 * 規則（§20 python 範例）：
 *   file in policy.forbidden → ArtifactViolation
 *   file in policy.readonly  → ReadonlyViolation
 *   file not in policy.allowed → UnauthorizedModification
 */
export function validatePatch(
  patch: { diff: string; files?: string[] },
  policy: ArtifactPolicy,
): ArtifactDecision {
  const files = patch.files ?? diffFiles(patch.diff);
  if (files.length === 0) {
    throw new ArtifactViolation("(empty diff)", "not_allowed");
  }
  const violations: ArtifactDecision["violations"] = [];
  for (const file of files) {
    if (policy.forbidden.some((p) => minimatch(file, p))) {
      violations.push({ file, rule: "forbidden" });
      continue;
    }
    if (policy.readonly.some((p) => minimatch(file, p))) {
      violations.push({ file, rule: "readonly" });
      continue;
    }
    if (!policy.allowed.some((p) => minimatch(file, p))) {
      violations.push({ file, rule: "not_allowed" });
    }
  }
  if (violations.length > 0) {
    throw new ArtifactViolation(violations[0]!.file, violations[0]!.rule);
  }
  return { verdict: "APPROVED", violations: [] };
}

/** execFile 不支援 stdin 餵入 → diff 寫入暫存檔 */
function writeDiffTmp(diff: string): string {
  const tmp = join(tmpdir(), `acp-patch-${randomUUID()}.diff`);
  writeFileSync(tmp, diff);
  return tmp;
}

export function createArtifactController(deps: ArtifactControllerDeps) {
  const db = deps.db;

  async function apply(patch: Patch, policy: ArtifactPolicy): Promise<AppliedPatch> {
    // 1. Policy Validation（在任何 filesystem 動作前拒絕）
    validatePatch(patch, policy);

    // 2. Git Diff Validation（dry-run：git apply --check）
    const checkTmp = writeDiffTmp(patch.diff);
    try {
      await execFileAsync("git", ["apply", "--check", checkTmp], {
        cwd: patch.workspaceDir,
      });
    } catch (err) {
      const msg = (err as Error).message.split("\n").slice(0, 3).join(" ");
      throw new ArtifactViolation(`(git apply --check 失敗) ${msg}`, "not_allowed");
    } finally {
      rmSync(checkTmp, { force: true });
    }

    // 3. Filesystem Apply
    const applyTmp = writeDiffTmp(patch.diff);
    try {
      await execFileAsync("git", ["apply", applyTmp], { cwd: patch.workspaceDir });
    } finally {
      rmSync(applyTmp, { force: true });
    }

    const patchId = randomUUID();
    db.prepare(
      `INSERT INTO patches (id, task_id, attempt, path, status, diff, workspace_dir, created_at)
       VALUES (?, ?, ?, ?, 'applied', ?, ?, ?)`,
    ).run(
      patchId,
      patch.taskId,
      patch.attempt,
      diffFiles(patch.diff).join(", "),
      patch.diff,
      patch.workspaceDir,
      new Date().toISOString(),
    );

    return {
      patchId,
      taskId: patch.taskId,
      attempt: patch.attempt,
      files: diffFiles(patch.diff),
      status: "applied",
      appliedAt: new Date().toISOString(),
    };
  }

  async function rollback(patchId: string): Promise<void> {
    const row = db.prepare("SELECT * FROM patches WHERE id = ?").get(patchId) as
      | PatchRow
      | undefined;
    if (!row) throw new Error(`patch not found: ${patchId}`);
    if (row.status !== "applied") {
      throw new Error(`patch ${patchId} 狀態為 ${row.status}，不可 rollback`);
    }
    if (!row.diff || !row.workspace_dir) {
      throw new Error(`patch ${patchId} 缺少 diff/workspace_dir`);
    }

    // 反套用：git apply --reverse；失敗即中止（保留原狀態）
    const tmp = writeDiffTmp(row.diff);
    try {
      await execFileAsync("git", ["apply", "--reverse", tmp], {
        cwd: row.workspace_dir,
      });
    } catch (err) {
      throw new Error(
        `rollback 失敗（patch ${patchId}）: ${(err as Error).message.split("\n")[0]}`,
      );
    } finally {
      rmSync(tmp, { force: true });
    }

    db.prepare("UPDATE patches SET status = 'rolled_back' WHERE id = ?").run(patchId);
  }

  return {
    apply,
    rollback,
    validate: validatePatch,
    diffFiles,
  };
}