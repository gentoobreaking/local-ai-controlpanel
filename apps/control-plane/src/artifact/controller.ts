// Artifact Controller（spec §20）。
// Patch 不能直接寫 filesystem：
//   Worker → Proposed Patch → Artifact Controller → Policy Validation
//   → Git Diff Validation → Filesystem Apply
// 所有 Worker（含未來 Cloud Worker）共用同一 Artifact Policy（Rule 2）。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, rmSync, readFileSync, mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ArtifactPolicy } from "../policy/schemas.js";
import type { ArtifactDecision } from "../policy/types.js";

const execFileAsync = promisify(execFile);

/**
 * T023 實測：模型常把整檔改寫輸出成行號不符的 hunk（git apply corrupt）。
 * 確定性容錯：對單一檔案，依序重放模型 hunk（context 容差比對）；
 * 任一個 hunk 全程無法對齊 → 退回「模型 add-lines 即為新內容」。
 * 回傳重建內容；無法重建（無 hunk、無 add）回傳 null。
 */
export function reconstructFile(
  current: string,
  sectionBody: string,
): string | null {
  const lines = current.split("\n");
  let hasOps = false;
  for (const l of sectionBody.split("\n")) {
    if (l.startsWith("+") || l.startsWith("-")) {
      hasOps = true;
      break;
    }
  }
  if (!hasOps) return null;

  // 解析 hunk blocks：header + ops 行
  const blocks: Array<{ startOld: number; ops: string[] }> = [];
  let cur: { startOld: number; ops: string[] } | null = null;
  const flush = (): void => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const line of sectionBody.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      flush();
      cur = { startOld: Number(m[1]), ops: [] };
      continue;
    }
    if (cur) cur.ops.push(line);
  }
  flush();
  if (blocks.length === 0) return null;

  const result: string[] = [];
  let idx = 0; // 目前線在全新內容的游標（= 已輸出並消費的舊行數）

  for (const block of blocks) {
    const ops = block.ops;
    const addLines = ops.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    // anchor = 第一個 context/del 行（模型裸行無 prefix → 當 context 對齊）
    let anchorText: string | null = null;
    for (const op of ops) {
      if (op.startsWith("+") || op.startsWith("\\")) continue;
      anchorText = op.startsWith("-") || op.startsWith(" ") ? op.slice(1) : op;
      break;
    }
    if (anchorText === null) {
      // 純新增：插在 startOld 位置（全新內容追加）
      if (addLines.length === 0) return null;
      for (const a of addLines) result.push(a);
      continue;
    }

    const windowLo = Math.max(0, block.startOld - 1 - 8);
    const windowHi = Math.min(lines.length, block.startOld - 1 + 8);
    let anchor = -1;
    for (let j = windowLo; j <= windowHi && j < lines.length; j += 1) {
      if (idx <= j && lines[j] === anchorText) {
        anchor = j;
        break;
      }
    }
    if (anchor < 0) {
      // 對不齊 context → 此 block 為「整檔改寫」語意：保留 context+add，丟 del（prefix 剝除）
      for (const op of ops) {
        if (op.startsWith("-") || op.startsWith("\\")) continue;
        if (op.startsWith("+")) result.push(op.slice(1));
        else if (op.startsWith(" ")) result.push(op.slice(1));
        else result.push(op);
      }
      continue;
    }

    let j = anchor;
    for (const op of ops) {
      if (op.startsWith("\\")) continue; // \ No newline
      if (op.startsWith("+")) {
        result.push(op.slice(1));
      } else if (op.startsWith("-")) {
        j += 1; // 吞掉對應的舊行
      } else {
        // context（git ' ' 前綴剝除；模型裸行原樣）
        result.push(op.startsWith(" ") ? op.slice(1) : op);
        j += 1;
      }
    }
    idx = j;
  }
  return result.join("\n");
}

/**
 * 重建混亂 patch（normalize 的最後手段）：整檔改寫語意。
 * 回傳「git diff --no-index」可用的 diff；失敗回傳 null。
 */
export async function rebuildSectionAsFullRewrite(
  section: string,
  workspaceDir: string,
  target: string,
): Promise<string | null> {
  const abs = join(workspaceDir, target);
  if (!existsSync(abs)) return null;
  const current = readFileSync(abs, "utf8");
  const newContent = reconstructFile(current, section);
  if (newContent === null) return null;
  const tmpName = `.acp-rewrite-${randomUUID()}.txt`;
  const tmp = join(workspaceDir, tmpName);
  writeFileSync(tmp, newContent.endsWith("\n") ? newContent : newContent + "\n");
  const res = await execFileAsync("git", ["diff", "--no-index", "--", target, tmpName], {
    maxBuffer: 8 * 1024 * 1024,
    cwd: workspaceDir,
  }).catch((e) => ({ stdout: e.stdout as string, stderr: e.stderr as string }));
  rmSync(tmp, { force: true });
  const gitDiff = (res.stdout ?? res.stderr ?? "") as string;
  let normalized = gitDiff
    .replace(/^diff --git a\/(\S+) b\/(\S*)\n/m, `diff --git a/${target} b/${target}\n`)
    .replace(new RegExp(`a/${tmpName}`, "g"), `a/${target}`)
    .replace(new RegExp(`b/${tmpName}`, "g"), `b/${target}`);
  if (!/^diff --git /.test(normalized)) {
    normalized = `diff --git a/${target} b/${target}\n${normalized}`;
  }
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
}

/**
 * 修正 hunk header 的行數宣告（T023 實測：模型輸出 hunk 計數常錯）：
 * `@@ -a,b +c,d @@` 的 b/d 與 body（空格=context、+、-）不符時，
 * 依 body 實際行數重寫宣告；行號 a/c 保留原樣。確定性、無 LLM。
 */
export function repairHunkCounts(diff: string): string {
  const out: string[] = [];
  let pending = -1;
  const flush = (endIdx: number): void => {
    if (pending < 0) return;
    const header = out[pending]!;
    const body = out.slice(pending + 1, endIdx);
    let ctxt = 0;
    let adds = 0;
    let dels = 0;
    for (const b of body) {
      if (!b) continue;
      if (b.startsWith("+")) adds += 1;
      else if (b.startsWith("-")) dels += 1;
      else ctxt += 1;
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!m) return;
    const oldStart = m[1];
    const newStart = m[3];
    const oldDecl = m[2];
    const newDecl = m[4];
    if (ctxt + dels !== Number(oldDecl ?? 1) || ctxt + adds !== Number(newDecl ?? 1)) {
      out[pending] = `@@ -${oldStart}${dels + ctxt === 1 ? "" : `,${dels + ctxt}`} +${newStart}${adds + ctxt === 1 ? "" : `,${adds + ctxt}`} @@`;
    }
    pending = -1;
  };
  for (const line of diff.split("\n")) {
    if (/^@@ -/.test(line)) {
      flush(out.length);
      pending = out.length;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  flush(out.length);
  return out.join("\n");
}

/**
 * 正規化 worker 產生的 diff（§20 Rule 2 統一入口）：
 * 針對模型常見輸出瑕疵（T023 實測）做確定性、無 LLM 的修正：
 *   1. 宣告為新檔案（--- /dev/null / new file mode）但目標檔案已存在 → 完整替換 diff。
 *   2. 目標檔案不存在（如模型「新增」未存在的 conftest.py）→ create-new diff。
 * 兩者皆以 git diff --no-index 重新生成（正確 hunk 計數），保證 git apply 可套用。
 */
export async function normalizeExistingFiles(
  diff: string,
  workspaceDir: string,
): Promise<string> {
  diff = repairHunkCounts(diff);
  const sections = diff.split(/(?=^diff --git )/m);
  const out: string[] = [];
  for (const section of sections) {
    if (!section.trim()) continue;
    const hasHeader = /^diff --git /.test(section);
    const plusLine = /^\+\+\+ (?:b\/)?(\S+)/m.exec(section);
    const isNewFile = /\/dev\/null/.test(section) || /new file mode/.test(section);
    // 支援 canonical diff 的 /dev/null 格式：先試標準 header，失敗則從 +++ 行取得
    const headerMatch = hasHeader ? /^diff --git a\/?(\S+) b\/?(\S+)/m.exec(section) : null;
    const target = (headerMatch?.[2] ?? plusLine?.[1])?.trim();
    const exists = Boolean(target && existsSync(join(workspaceDir, target)));

    // 需重新生成的情形：宣告 new 但已存在（replace）／目標不存在（create）。
    if ((isNewFile && exists) || (target && !exists)) {
      // 收集新增內容（+ 行，去除 +；跳過 hunk header 與 \ No newline 標記）
      const added: string[] = [];
      for (const line of section.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("@@") || line.startsWith("diff --git")) continue;
        if (line.startsWith("new file mode")) continue;
        if (line.startsWith("+")) added.push(line.slice(1));
      }
      if (added.length === 0) {
        out.push(section);
        continue;
      }
      const tmpName = `.acp-norm-${randomUUID()}.txt`;
      const newFile = join(workspaceDir, tmpName);
      writeFileSync(newFile, added.join("\n") + "\n");
      let stdout = "";
      try {
        // old 端：目標已存在 → 與現有內容 diff（replace）；不存在 → /dev/null（create）
        const oldRef = exists && target ? target : "/dev/null";
        const res = await execFileAsync(
          "git",
          ["diff", "--no-index", "--", oldRef, tmpName],
          { maxBuffer: 8 * 1024 * 1024, cwd: workspaceDir },
        ).catch((err) => {
          // exit code 1 = 有差異（正常輸出在 stdout）；其他錯誤才拋出
          if (err.code === 1 && err.stdout) return { stdout: err.stdout };
          throw err;
        });
        stdout = res.stdout;
      } finally {
        rmSync(newFile, { force: true });
      }
      // 統一 output 端路徑為 b/<target>、剝除 index 行；缺 diff --git 頭時補上
      let normalized = stdout
        .split("\n")
        .filter(
          (line: string) =>
            !/^index /.test(line) &&
            line !== "" &&
            !/^diff --git /.test(line),
        )
        .map((line: string) => line.replace(`b/${tmpName}`, `b/${target}`))
        .join("\n");
      if (!/^diff --git /.test(normalized)) {
        normalized = `diff --git a/${target} b/${target}\n${normalized}`;
      }
      out.push(normalized.endsWith("\n") ? normalized : normalized + "\n");
    } else {
      out.push(section);
    }
  }
  return out.join("").replace(/^(\s*\n)+/, "");
}

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

/**
 * Canonicalize（T023）：把 model raw diff 套到 scratch copy 後，以
 * `git diff --no-index` 產出「真實內容變更」的最小 diff。
 * 模型把整檔重 emit、hunk 錯、重複新增已存在內容等垃圾會在此消散；
 * 未造成實質改變的檔案（如 tests/ 重複 emit 內容相同）不會出現在結果，
 * 因此政策 readonly/forbidden 驗證以「實際變更」為準。
 * 回傳 canonical diff（可能為空字串＝無實質變更）。
 */
export async function canonicalizeDiff(rawDiff: string, workspaceDir: string): Promise<string> {
  // 空 diff 直接返回空字串
  if (!rawDiff || !rawDiff.trim()) {
    return "";
  }
  const scratch = mkdtempSync(join(tmpdir(), "acp-canon-"));
  try {
    cpSync(workspaceDir, scratch, { recursive: true, filter: (src) => !src.includes(".git") });
    // 直接使用內部 applyDiffToDir 邏輯（複製這裡避免循環依賴）
    const normalized = await normalizeExistingFiles(rawDiff, scratch);
    let resolved = normalized;
    const gitApplyOk = async (diff: string): Promise<boolean> => {
      const t = writeDiffTmp(diff);
      try {
        await execFileAsync("git", ["apply", "--check", t], { cwd: scratch });
        return true;
      } catch {
        return false;
      } finally {
        rmSync(t, { force: true });
      }
    };
    if (!(await gitApplyOk(normalized))) {
      const rawSections = normalized.split(/(?=^diff --git )/m).filter((s) => s.trim());
      const rebuiltSections = await Promise.all(
        rawSections.map(async (section) => {
          let target = /^diff --git a\/?(\S+) b\/?(\S+)/m.exec(section)?.[2];
          if (!target) {
            target = /^\+\+\+ b\/?(\S+)/m.exec(section)?.[1];
            if (!target) target = /^--- a\/?(\S+)/m.exec(section)?.[1];
          }
          if (!target) return section;
          const rebuilt = await rebuildSectionAsFullRewrite(section, scratch, target);
          return rebuilt && (await gitApplyOk(rebuilt)) ? rebuilt : section;
        }),
      );
      const joined = rebuiltSections.join("");
      if (await gitApplyOk(joined)) {
        resolved = joined;
      } else {
        const msg = (await execFileAsync("git", ["apply", "--check", writeDiffTmp(normalized)], { cwd: scratch })
          .then(() => "ok")
          .catch((e) => (e as Error).message) as string)
          .split("\n")
          .slice(0, 3)
          .join(" ");
        throw new ArtifactViolation(`(git apply --check 失敗) ${msg}`, "not_allowed");
      }
    }
    const applyTmp = writeDiffTmp(resolved);
    try {
      await execFileAsync("git", ["apply", applyTmp], { cwd: scratch });
    } finally {
      rmSync(applyTmp, { force: true });
    }
    // 產生 canonical diff
    const files = diffFiles(resolved);
    const sections: string[] = [];
    for (const f of files) {
      const orig = join(workspaceDir, f);
      const cand = join(scratch, f);
      const oExists = existsSync(orig);
      const cExists = existsSync(cand);
      if (!oExists && !cExists) continue;
      const cmpDir = join(scratch, ".acp-cmp");
      mkdirSync(cmpDir, { recursive: true });
      const oName = join(cmpDir, "orig.bin");
      const cName = join(cmpDir, "cand.bin");
      if (oExists) {
        cpSync(orig, oName);
      } else {
        writeFileSync(oName, "");
      }
      if (cExists) cpSync(cand, cName);
      const res = await execFileAsync(
        "git",
        ["diff", "--no-index", "--", oName, cName],
        { cwd: scratch, maxBuffer: 8 * 1024 * 1024 },
      ).catch((e) => ({ stdout: (e.stdout as string) ?? "", stderr: (e.stderr as string) ?? "" }));
      rmSync(oName, { force: true });
      rmSync(cName, { force: true });
      let raw = (res.stdout ?? res.stderr ?? "") as string;
      if (!raw.trim()) continue;
      const created = !oExists && cExists;
      const deleted = oExists && !cExists;
      raw = raw
        .replace(/^diff --git .*\n/m, `diff --git ${created ? "/dev/null b/" + f : deleted ? "a/" + f + " /dev/null" : "a/" + f + " b/" + f}\n`)
        .replace(/^--- .*$/m, created ? "--- /dev/null" : `--- a/${f}`)
        .replace(/^\+\+\+ .*$/m, deleted ? "+++ /dev/null" : `+++ b/${f}`)
        .replace(/^(index .*)$/m, "");
      if (!/^diff --git /m.test(raw)) continue;
      sections.push(raw);
    }
    return sections.join("");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function createArtifactController(deps: ArtifactControllerDeps) {
  const db = deps.db;

  /**
   * 容錯式「resolve + git apply」核心（不含 policy 驗證、不含 db 寫入）。
   * 回傳最終套用的 resolved diff（可能與輸入不同——已修過行數/重建）。
   * 規則：
   *   1. normalize（repairHunkCounts + 新檔/替換語意）
   *   2. git apply --check；失敗 → 逐檔案 rebuildSectionAsFullRewrite 重建
   *   3. git apply
   */
  async function applyDiffToDir(rawDiff: string, dir: string): Promise<string> {
    const normalized = await normalizeExistingFiles(rawDiff, dir);
    let resolved = normalized;
    const gitApplyOk = async (diff: string): Promise<boolean> => {
      const t = writeDiffTmp(diff);
      try {
        await execFileAsync("git", ["apply", "--check", t], { cwd: dir });
        return true;
      } catch {
        return false;
      } finally {
        rmSync(t, { force: true });
      }
    };
    if (!(await gitApplyOk(normalized))) {
      const rawSections = normalized.split(/(?=^diff --git )/m).filter((s) => s.trim());
      const rebuiltSections = await Promise.all(
        rawSections.map(async (section) => {
          let target = /^diff --git a\/?(\S+) b\/?(\S+)/m.exec(section)?.[2];
          if (!target) {
            target = /^\+\+\+ b\/?(\S+)/m.exec(section)?.[1];
            if (!target) target = /^--- a\/?(\S+)/m.exec(section)?.[1];
          }
          if (!target) return section;
          const rebuilt = await rebuildSectionAsFullRewrite(section, dir, target);
          return rebuilt && (await gitApplyOk(rebuilt)) ? rebuilt : section;
        }),
      );
      const joined = rebuiltSections.join("");
      if (await gitApplyOk(joined)) {
        resolved = joined;
      } else {
        const msg = (await execFileAsync("git", ["apply", "--check", writeDiffTmp(normalized)], { cwd: dir })
          .then(() => "ok")
          .catch((e) => (e as Error).message) as string)
          .split("\n")
          .slice(0, 3)
          .join(" ");
        throw new ArtifactViolation(`(git apply --check 失敗) ${msg}`, "not_allowed");
      }
    }
    const applyTmp = writeDiffTmp(resolved);
    try {
      await execFileAsync("git", ["apply", applyTmp], { cwd: dir });
    } finally {
      rmSync(applyTmp, { force: true });
    }
    return resolved;
  }

/** execFile 不支援 stdin 餵入 → diff 寫入暫存檔 */
function writeDiffTmp(diff: string): string {
  const tmp = join(tmpdir(), `acp-patch-${randomUUID()}.diff`);
  writeFileSync(tmp, diff);
  return tmp;
}

  async function apply(patch: Patch, policy: ArtifactPolicy): Promise<AppliedPatch> {
    // 0. 正規化 worker diff（new-file ↔ 已存在檔案；§20 統一入口）
    const normalized = await normalizeExistingFiles(patch.diff, patch.workspaceDir);

    // 1. Policy Validation（在任何 filesystem 動作前拒絕）
    validatePatch({ diff: normalized }, policy);

    // 2+3. Git Diff Validation（dry-run）＋容錯重建＋Filesystem Apply
    const resolved = await applyDiffToDir(normalized, patch.workspaceDir);

    const patchId = randomUUID();
    db.prepare(
      `INSERT INTO patches (id, task_id, attempt, path, status, diff, workspace_dir, created_at)
       VALUES (?, ?, ?, ?, 'applied', ?, ?, ?)`,
    ).run(
      patchId,
      patch.taskId,
      patch.attempt,
      diffFiles(resolved).join(", "),
      resolved,
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
    normalizeExistingFiles,
  };
}

export type { ArtifactPolicy };
export type ArtifactController = ReturnType<typeof createArtifactController>;