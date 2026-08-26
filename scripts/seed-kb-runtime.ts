#!/usr/bin/env npx tsx
// 播種：StyleKB 案例 + Project Memory（含 schema 修復與向量計算）
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { StyleKnowledgeBase, type StyleCase } from "../apps/control-plane/src/rag/style-kb.js";
import { MemoryRetriever } from "../apps/control-plane/src/memory/retriever.js";

const dbPath = resolve(import.meta.dirname!, "../apps/control-plane/.acp-data/control-plane.db");
const db = new DatabaseSync(dbPath);

// ── 1. 修復 project_memory 缺失欄位（舊 migration 建表無 tags/vector）──
const cols = (db.prepare("PRAGMA table_info(project_memory)").all() as Array<{ name: string }>).map((c) => c.name);
if (!cols.includes("tags")) db.exec("ALTER TABLE project_memory ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("vector")) db.exec("ALTER TABLE project_memory ADD COLUMN vector BLOB");
console.log(`project_memory columns: ${cols.includes("tags") ? "ok" : "added tags"}, vector ensured`);

// ── 2. StyleKB 案例 ──
const kb = new StyleKnowledgeBase(db);
const styleCases: StyleCase[] = [
  {
    id: "seed-zerodiv-valueerror",
    language: "python",
    errorType: "ZeroDivisionError",
    errorSnippet: "def safe_divide(a, b):\n    return a / b",
    fixedDiff: ' def safe_divide(a, b):\n+    if b == 0:\n+        raise ValueError("division by zero")\n     return a / b',
    createdAt: new Date().toISOString(),
    isFewShot: false,
  },
];
for (const c of styleCases) {
  kb.upsert(c);
  console.log(`style-kb seeded: ${c.id}`);
}

// ── 3. 專案記憶（storeMemory 自動算向量）──
const mem = new MemoryRetriever(dbPath);
mem.storeMemory({
  taskId: "seed",
  project: "acp-demo",
  language: "python",
  errorType: "ZeroDivisionError",
  fixedDiff:
    "safe_divide 除法前檢查 b == 0 並拋出 ValueError；驗證指令 python3 -m pytest tests/ -q 須全數通過",
  tags: ["python", "pytest", "guard-clause"],
});
console.log(`memory seeded for acp-demo: ${mem.listMemories("acp-demo").length} records`);
