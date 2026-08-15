// RAG 風格知識庫（T029）— 風格修正案例的檢索知識庫。
//
// 儲存（錯誤類型、語言、錯誤輸出、修正 diff、時間戳）於 SQLite（node:sqlite，零原生相依），
// 並以字元 n-gram hash 產出 256 維向量（確定性、不需外部 embedding 服務）。
// 檢索：輸入（語言、錯誤類型、錯誤片段）→ 過濾「同語言、同錯誤類型、最近 maxAgeDays 天」
// → 依片段相似度排序 → Top-K。
//
// 去重（T028）：is_few_shot=1 的內建 few-shot 案例永不進入檢索結果。

import { DatabaseSync } from "node:sqlite";
import type { PiContract } from "../worker/pi-worker.js";

export interface StyleCase {
  id: string;
  /** 語言：python | typescript | go | kubernetes | ansible | yaml … */
  language: string;
  /** 錯誤類型（lint 代碼或分類）：F401 / E302 / E501 / F403 / E999 … */
  errorType: string;
  /** 錯誤輸出片段（檢索用特徵）。 */
  errorSnippet: string;
  /** 修正後 code diff（僅關鍵變更）。 */
  fixedDiff: string;
  createdAt: string;
  /** T028 內建 few-shot 案例標記——RAG 檢索一律排除（去重）。 */
  isFewShot?: boolean;
}

export interface StyleKbSearchOptions {
  language: string;
  errorType?: string;
  snippet?: string;
  topK?: number;
  /** 只檢索最近 N 天的案例（預設 30）。 */
  maxAgeDays?: number;
}

/** 向量維度（字元 3-gram hash → 256 維）。 */
export const VECTOR_DIM = 256;

/** 字元 trigram → 256 維稀疏向量（hash 決定 bin；重複計數）。 */
export function ngramVector(text: string, dim: number = VECTOR_DIM): Float32Array {
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

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
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
  // SQLite 回傳的 BLOB 可能是 Uint8Array/Buffer，需安全轉 Float32Array
  if (buf.length !== VECTOR_DIM * 4) return new Float32Array(VECTOR_DIM);
  const out = new Float32Array(VECTOR_DIM);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < VECTOR_DIM; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export class StyleKnowledgeBase {
  constructor(private readonly db: DatabaseSync) {
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS style_cases (
  id TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_snippet TEXT NOT NULL,
  fixed_diff TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_few_shot INTEGER NOT NULL DEFAULT 0,
  vector BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_style_cases_lang_type ON style_cases (language, error_type);
CREATE INDEX IF NOT EXISTS idx_style_cases_created ON style_cases (created_at);
`);
  }

  upsert(c: StyleCase): void {
    const row = this.db
      .prepare(
        `INSERT INTO style_cases (id, language, error_type, error_snippet, fixed_diff, created_at, is_few_shot, vector)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           language=excluded.language, error_type=excluded.error_type,
           error_snippet=excluded.error_snippet, fixed_diff=excluded.fixed_diff,
           created_at=excluded.created_at, is_few_shot=excluded.is_few_shot,
           vector=excluded.vector`,
      )
      .run(
        c.id,
        c.language,
        c.errorType,
        c.errorSnippet,
        c.fixedDiff,
        c.createdAt,
        c.isFewShot ? 1 : 0,
        vecToBlob(ngramVector(`${c.errorType} ${c.language} ${c.errorSnippet}`)),
      );
  }

  /** 檢索 Top-K：同語言 + 同錯誤類型（若有）+ 最近 N 天 + 排除 few-shot，依片段相似度排序。 */
  search(opts: StyleKbSearchOptions): StyleCase[] {
    const { language, errorType, snippet, topK = 3, maxAgeDays = 30 } = opts;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString();
    const params: Array<string | number> = [language, cutoff];
    let where = "is_few_shot = 0 AND language = ? AND created_at >= ?";
    if (errorType) {
      where += " AND error_type = ?";
      params.push(errorType);
    }
    const rows = this.db
      .prepare(
        `SELECT id, language, error_type, error_snippet, fixed_diff, created_at, is_few_shot, vector
         FROM style_cases WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];

    const queryVec = snippet ? ngramVector(`${opts.errorType ?? ""} ${snippet}`) : null;
    const scored = rows.map((r) => {
      const vec = blobToVec(r.vector instanceof Uint8Array ? r.vector : null);
      const c = this.rowToCase(r);
      const sim = queryVec ? cosineSim(queryVec, vec) : 0;
      return { c, sim };
    });
    scored.sort((a, b) =>
      queryVec
        ? b.sim - a.sim || b.c.createdAt.localeCompare(a.c.createdAt)
        : b.c.createdAt.localeCompare(a.c.createdAt),
    );
    return scored.slice(0, topK).map((s) => s.c);
  }

  /** 全部案例（供除錯 / 匯出）。 */
  list(): StyleCase[] {
    const rows = this.db
      .prepare(
        `SELECT id, language, error_type, error_snippet, fixed_diff, created_at, is_few_shot
         FROM style_cases ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToCase(r));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM style_cases").get() as { n: number };
    return row.n;
  }

  private rowToCase(r: Record<string, unknown>): StyleCase {
    return {
      id: String(r.id),
      language: String(r.language),
      errorType: String(r.error_type),
      errorSnippet: String(r.error_snippet),
      fixedDiff: String(r.fixed_diff),
      createdAt: String(r.created_at),
      isFewShot: (r.is_few_shot as number) === 1,
    };
  }
}

// ── Pi Worker 整合 ────────────────────────────────────────────────────

/**
 * 由 contract / workspace 解析語言（啟發式：以 workspace 內檔案副檔名為準；
 * 畫面無法判定時回傳 "unknown"——此時仍以錯誤類型過濾檢索）。
 */
export function detectLanguageFromContract(contract: PiContract): string {
  const counts = new Map<string, number>();
  for (const f of contract.allowed_files) {
    const ext = f.slice(f.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "py") increment(counts, "python");
    else if (ext === "go") increment(counts, "go");
    else if (ext === "ts" || ext === "tsx" || ext === "js") increment(counts, "typescript");
    else if (ext === "yaml" || ext === "yml") increment(counts, "kubernetes");
    else if (ext === "tf") increment(counts, "terraform");
  }
  let best = "";
  let bestN = 0;
  for (const [lang, n] of counts) {
    if (n > bestN) {
      best = lang;
      bestN = n;
    }
  }
  return best;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 從驗證失敗輸出抽取 lint 錯誤代碼（F401 / E302 / E501 / F403 …）。 */
export function extractErrorTypes(output: string): string[] {
  const found = new Set<string>();
  output.replace(/([A-Z]\d{3})/g, (m) => {
    if (!/^(E9|F|W|I|E1|E2|E3|E4|E7|E8)/.test(m)) return m;
    found.add(m);
    return m;
  });
  return [...found];
}

/** 預設 retriever：產生可供 PiWorker 呼叫的檢索函式（輸入 contract → StyleCase[]）。 */
export function createStyleKbRetriever(
  kb: StyleKnowledgeBase,
  opts: { language?: (contract: PiContract) => string } = {},
): (contract: PiContract) => StyleCase[] {
  return (contract: PiContract) => {
    const language = opts.language ? opts.language(contract) : detectLanguageFromContract(contract);
    const feedback = contract.previous_feedback ?? "";
    const errorTypes = extractErrorTypes(feedback);
    const snippet = feedback.toLowerCase().includes("lint")
      ? feedback.slice(0, 300)
      : feedback.slice(0, 300);
    return kb.search({
      language,
      errorType: errorTypes[0],
      snippet,
      topK: 3,
      maxAgeDays: 30,
    });
  };
}