// Project Memory Retriever（Spec §26）
//
// 提供專案層級的長期記憶存儲與檢索：
// - storeMemory: 儲存成功的修正模式（只存「修正後」的關鍵模式）
// - retrieveMemory: 依語言、錯誤類型、關鍵字檢索 Top-K 相關記憶
// - 使用 SQLite project_memory table + 應用層關鍵字/向量相似度檢索
//
// 注意：與 T029 RAG 風格知識庫共用向量基礎設施，但語義不同：
//   - T029 RAG: 跨專案的「錯誤→修正」歷史案例（知識庫）
//   - T032 Memory: 單一專案內的「成功修正模式」累積（專案記憶）

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryRecord,
  MemoryQuery,
  MemorySearchResult,
  MemoryStoreTrigger,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const REPO_ROOT = resolve(__dirname, "../../..");
const DEFAULT_DB_PATH = resolve(REPO_ROOT, "apps/control-plane/.project-memory.db");

const VECTOR_DIM = 256;

/** 字元 3-gram FNV-1a hash 向量 */
function ngramVector(text: string, dim: number = VECTOR_DIM): Float32Array {
  const v = new Float32Array(dim);
  const t = text.toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    let h = 2166136261;
    for (let j = 0; j < g.length; j++) {
      h ^= g.charCodeAt(j);
      h = Math.imul(h, 16777619);
    }
    const idx = (h >>> 0) % dim;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  if (t.length === 0) v[0] = 1;
  return v;
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function blobToVec(buf: Uint8Array | null): Float32Array {
  if (!buf || buf.length === 0) return new Float32Array(VECTOR_DIM);
  if (buf.length !== VECTOR_DIM * 4) return new Float32Array(VECTOR_DIM);
  const out = new Float32Array(VECTOR_DIM);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < VECTOR_DIM; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/** Project Memory Retriever */
export class MemoryRetriever {
  private db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    // 使用現有 project_memory table，確保有 tags 和 vector 欄位
    this.db.exec(`
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  vector BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory (project);
CREATE INDEX IF NOT EXISTS idx_project_memory_key ON project_memory (key);
`);
  }

  /** 生成記憶鍵：language:error_type:keywords */
  private generateKey(trigger: MemoryStoreTrigger): string {
    const keywords = trigger.fixedDiff
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 3)
      .join("_");
    return `${trigger.language}:${trigger.errorType}:${keywords || "fix"}`.toLowerCase();
  }

  /** 生成向量文本用於相似度計算 */
  private vectorText(trigger: MemoryStoreTrigger): string {
    return `${trigger.language} ${trigger.errorType} ${trigger.fixedDiff} ${trigger.tags.join(" ")}`;
  }

  /** 儲存成功的修正模式 */
  storeMemory(trigger: MemoryStoreTrigger): void {
    const now = new Date().toISOString();
    const key = this.generateKey(trigger);
    const id = `${trigger.project}:${key}:${Date.now()}`;

    // 檢查是否已存在相同 key（避免重複）
    const existing = this.db
      .prepare("SELECT id FROM project_memory WHERE project = ? AND key = ?")
      .get(trigger.project, key) as { id: string } | undefined;

    const tagsJson = JSON.stringify(trigger.tags);
    const vector = vecToBlob(ngramVector(this.vectorText(trigger)));

    if (existing) {
      this.db
        .prepare(
          `UPDATE project_memory SET value = ?, tags = ?, updated_at = ?, vector = ? WHERE id = ?`
        ).run(trigger.fixedDiff, tagsJson, now, vector, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO project_memory (id, project, key, value, tags, created_at, updated_at, vector)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, trigger.project, key, trigger.fixedDiff, tagsJson, now, now, vector);
    }
  }

  /** 檢索相關記憶 */
  retrieveMemory(query: MemoryQuery): MemorySearchResult[] {
    const { project, query: queryText, topK = 3, threshold = 0.7, tags } = query;

    // 先用 tags + keyword 過濾候選
    let sql = "SELECT id, project, key, value, tags, created_at, updated_at, vector FROM project_memory WHERE project = ?";
    const params: (string | number)[] = [project];

    if (tags && tags.length > 0) {
      // 簡單的 tags 過濾：任一 tag 包含
      const tagConditions = tags.map(() => "tags LIKE ?").join(" OR ");
      sql += ` AND (${tagConditions})`;
      for (const tag of tags) params.push(`%${tag}%`);
    }

    // 加上關鍵字模糊匹配
    const queryKeywords = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (queryKeywords.length > 0) {
      const kwConditions = queryKeywords.map(() => "key LIKE ?").join(" OR ");
      sql += ` AND (${kwConditions})`;
      for (const kw of queryKeywords) params.push(`%${kw}%`);
    }

    sql += " ORDER BY updated_at DESC LIMIT 100";

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      project: string;
      key: string;
      value: string;
      tags: string;
      created_at: string;
      updated_at: string;
      vector: Uint8Array | null;
    }>;

    if (rows.length === 0) return [];

    // 向量相似度排序
    const queryVec = ngramVector(queryText);
    const scored = rows.map((row) => {
      const vec = blobToVec(row.vector);
      const score = cosineSim(queryVec, vec);
      return {
        record: {
          id: row.id,
          project: row.project,
          key: row.key,
          value: row.value,
          tags: JSON.parse(row.tags || "[]"),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score >= threshold)
      .slice(0, topK);
  }

  /** 取得專案所有記憶（除錯用） */
  listMemories(project: string): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT id, project, key, value, tags, created_at, updated_at FROM project_memory WHERE project = ? ORDER BY updated_at DESC")
      .all(project) as Array<{
        id: string;
        project: string;
        key: string;
        value: string;
        tags: string;
        created_at: string;
        updated_at: string;
      }>;

    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      key: r.key,
      value: r.value,
      tags: JSON.parse(r.tags || "[]"),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** 清除專案記憶（測試用） */
  clearProject(project: string): number {
    const result = this.db.prepare("DELETE FROM project_memory WHERE project = ?").run(project);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

// 單例模式（供 Pi Worker 使用）
let _instance: MemoryRetriever | null = null;

export function getMemoryRetriever(dbPath?: string): MemoryRetriever {
  if (!_instance) _instance = new MemoryRetriever(dbPath);
  return _instance;
}