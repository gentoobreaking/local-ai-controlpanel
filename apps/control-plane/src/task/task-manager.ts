// Task Manager（spec §8 / §27）：task CRUD、attempt、flags、關聯查詢。

import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import {
  type Complexity,
  type CreateTaskInput,
  type RiskLevel,
  type SandboxMode,
  type TaskDetail,
  type TaskRow,
  type TaskStatus,
  type TaskSummary,
} from "./types.js";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "COMPLETE",
  "STOP",
  "CANCELLED",
]);

export class TaskManager {
  constructor(public readonly db: Db) {}

  private nextTaskSeq(): number {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = 'task_seq'")
      .get() as { value: string } | undefined;
    const next = row ? Number(row.value) + 1 : 1;
    this.db
      .prepare(
        "INSERT INTO app_meta (key, value) VALUES ('task_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(next));
    return next;
  }

  create(input: CreateTaskInput): TaskRow {
    const now = new Date().toISOString();
    const id = `TASK-${String(this.nextTaskSeq()).padStart(3, "0")}`;
    this.db
      .prepare(
      `INSERT INTO tasks (id, request, status, complexity, risk, sandbox_mode, workspace, flags, attempt, created_at, updated_at)
          VALUES (?, ?, 'CREATED', ?, ?, ?, ?, '[]', 1, ?, ?)`,
      )
      .run(
        id,
        input.userRequest,
        input.complexity ?? null,
        input.risk ?? null,
        input.sandboxMode ?? null,
        input.workspace ?? null,
        now,
        now,
      );
    return this.getRow(id)!;
  }

  private mapRow(r: Record<string, unknown>): TaskRow {
    return {
      id: String(r.id),
      request: String(r.request),
      status: r.status as TaskStatus,
      complexity: (r.complexity as TaskRow["complexity"]) ?? null,
      risk: (r.risk as TaskRow["risk"]) ?? null,
      sandboxMode: (r.sandbox_mode as TaskRow["sandboxMode"]) ?? null,
      workspace: (r.workspace as string | null) ?? null,
      flags: JSON.parse(String(r.flags)) as string[],
      attempt: Number(r.attempt),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  getRow(id: string): TaskRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return r ? this.mapRow(r) : undefined;
  }

  list(): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  updateStatus(id: string, status: TaskStatus): TaskRow {
    this.assertExists(id);
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.getRow(id)!;
  }

  addFlag(id: string, flag: string): TaskRow {
    this.assertExists(id);
    const task = this.getRow(id)!;
    const flags = task.flags.includes(flag) ? task.flags : [...task.flags, flag];
    this.db
      .prepare("UPDATE tasks SET flags = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(flags), new Date().toISOString(), id);
    return this.getRow(id)!;
  }

  setAttempt(id: string, attempt: number): TaskRow {
    this.assertExists(id);
    this.db
      .prepare("UPDATE tasks SET attempt = ?, updated_at = ? WHERE id = ?")
      .run(attempt, new Date().toISOString(), id);
    return this.getRow(id)!;
  }

  isTerminal(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  /** 更新一個 task 的多個欄位（undefined 表示不更新）。 */
  update(
    id: string,
    fields: {
      complexity?: Complexity | null;
      risk?: RiskLevel | null;
      sandboxMode?: SandboxMode | null;
    },
  ): TaskRow {
    this.assertExists(id);
    const sets: string[] = [];
    const args: import("node:sqlite").SQLInputValue[] = [];
    if ("complexity" in fields) {
      sets.push("complexity = ?");
      args.push(fields.complexity ?? null);
    }
    if ("risk" in fields) {
      sets.push("risk = ?");
      args.push(fields.risk ?? null);
    }
    if ("sandboxMode" in fields) {
      sets.push("sandbox_mode = ?");
      args.push(fields.sandboxMode ?? null);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      args.push(new Date().toISOString());
      this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    }
    return this.getRow(id)!;
  }

  // ---- 關聯查詢（§27 慣例） ----

  recordAttempt(id: string, attempt: number, worker: string, model: string): void {
    this.db
      .prepare(
        `INSERT INTO attempts (id, task_id, attempt, worker, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'started', ?)`,
      )
      .run(randomUUID(), id, attempt, worker, model, new Date().toISOString());
  }

  recordApproval(
    id: string,
    kind: string,
    actor: string,
    reason?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, kind, actor, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, kind, actor, reason ?? null, new Date().toISOString());
  }

  /** §36.2 Prevention Rate：記錄 evidence gate 決策（BLOCK 計入分子）。 */
  recordGateBlock(
    id: string,
    decision: string,
    stage1: string,
    stage2: string,
    reason: string,
    retriesUsed = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO gate_blocks (id, task_id, decision, stage1, stage2, reason, retries_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, decision, stage1, stage2, reason, retriesUsed, new Date().toISOString());
  }

  /** §36.2：gate block 總數（供 Prevention Rate 計算）。 */
  gateBlockCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM gate_blocks WHERE decision = 'BLOCK'`)
      .get() as { c: number };
    return Number(row.c);
  }

  evidenceCount(id: string): { count: number; confidence: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, AVG(confidence) AS avg_conf
         FROM evidence WHERE task_id = ?`,
      )
      .get(id) as { count: number; avg_conf: number | null };
    return {
      count: Number(row.count),
      confidence: row.avg_conf === null ? null : Number(row.avg_conf),
    };
  }

  verificationSummary(id: string): TaskDetail["verification"] {
    const row = this.db
      .prepare(
        `SELECT verifier, status, sandbox_mode, duration_ms
         FROM verification_results WHERE task_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as
      | { verifier: string; status: string; sandbox_mode: string | null; duration_ms: number | null }
      | undefined;
    if (!row) return undefined;
    return {
      verifier: row.verifier,
      status: row.status,
      sandbox: row.sandbox_mode ?? undefined,
      durationMs: row.duration_ms ?? undefined,
    };
  }

  toSummary(task: TaskRow): TaskSummary {
    return {
      id: task.id,
      userRequest: task.request,
      status: task.status,
      attempt: task.attempt,
      sandboxMode: task.sandboxMode ?? undefined,
      updatedAt: task.updatedAt,
    };
  }

  toDetail(task: TaskRow): TaskDetail {
    const evidence = this.evidenceCount(task.id);
    return {
      ...this.toSummary(task),
      complexity: task.complexity ?? undefined,
      risk: task.risk ?? undefined,
      flags: task.flags,
      workspace: task.workspace ?? undefined,
      createdAt: task.createdAt,
      evidence:
        evidence.count > 0
          ? { count: evidence.count, confidence: evidence.confidence ?? undefined }
          : undefined,
      verification: this.verificationSummary(task.id),
    };
  }

  private assertExists(id: string): void {
    if (!this.getRow(id)) throw new Error(`task not found: ${id}`);
  }
}

export function createTaskManager(db: Db): TaskManager {
  return new TaskManager(db);
}
