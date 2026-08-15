#!/usr/bin/env npx tsx
/**
 * T029 風格知識庫種子腳本（style-kb-seed.ts）
 * 用法：npx tsx scripts/style-kb-seed.ts [--db PATH]
 * 預設將 KB 寫入 apps/control-plane/.style-kb.db
 */

import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StyleKnowledgeBase,
  ngramVector,
  VECTOR_DIM,
  StyleCase,
} from "../apps/control-plane/src/rag/style-kb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_DB = resolve(REPO_ROOT, "apps/control-plane/.style-kb.db");

function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

const FEW_SHOT_CASES: StyleCase[] = [
  {
    id: "t028-fs-1",
    language: "python",
    errorType: "F401",
    errorSnippet: "def fetch(url):\n    import requests\n    return requests.get(url)",
    fixedDiff: "+import requests\n+\ndef fetch(url):\n-    import requests\n     return requests.get(url)",
    createdAt: "2026-08-15T00:00:00.000Z",
    isFewShot: true,
  },
  {
    id: "t028-fs-2",
    language: "python",
    errorType: "E302",
    errorSnippet: "import json\n\ndef load_config(text):",
    fixedDiff: " import json\n+\n+def load_config(text):",
    createdAt: "2026-08-15T00:00:00.000Z",
    isFewShot: true,
  },
  {
    id: "t028-fs-3",
    language: "python",
    errorType: "E501",
    errorSnippet: "    return collect_metrics(process=process, labels=labels, cache=cache, retries=retries)",
    fixedDiff: "-    return collect_metrics(process=process, labels=labels, cache=cache, retries=retries)\n+    return collect_metrics(\n+        process=process,\n+        labels=labels,\n+        cache=cache,\n+        retries=retries,\n+    )",
    createdAt: "2026-08-15T00:00:00.000Z",
    isFewShot: true,
  },
  {
    id: "t028-fs-4",
    language: "python",
    errorType: "F403",
    errorSnippet: "from os import *",
    fixedDiff: "-from os import *\n+import os",
    createdAt: "2026-08-15T00:00:00.000Z",
    isFewShot: true,
  },
];

/** 觀察到的真實失敗案例（T028 驗證中發現）：模型整檔重寫導致 docstring 損壞 → E999 */
const OBSERVED_CASES: StyleCase[] = [
  {
    id: "t028-obs-e999-1",
    language: "python",
    errorType: "E999",
    errorSnippet: `"""Demo module: uses \`requests\` external library.

Task: implement \`get_status_code(url)\` that performs a GET request and
    """Perform a GET request and return the HTTP status code."""
    import requests`,
    fixedDiff: `-"""Demo module: uses \`requests\` external library.

Task: implement \`get_status_code(url)\` that performs a GET request and
    """Perform a GET request and return the HTTP status code."""
    import requests
+"""Demo module: uses \`requests\` external library.

Task: implement \`get_status_code(url)\` that performs a GET request and
returns the HTTP status code. The current \`requests\` API must be researched
(e.g. \`requests.get()\` returns a \`Response\` object with \`.status_code\`).
"""
+import requests
+
+def get_status_code(url):
+    response = requests.get(url)
+    return response.status_code`,
    createdAt: "2026-08-15T12:00:00.000Z",
    isFewShot: false,
  },
];

function main() {
  const argv = process.argv.slice(2);
  const dbPath = argv.includes("--db") ? argv[argv.indexOf("--db") + 1] : DEFAULT_DB;

  console.log(`[seed] Opening DB: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  const kb = new StyleKnowledgeBase(db);

  // 插入 few-shot 內建案例（isFewShot=true，RAG 檢索時自動排除）
  for (const c of FEW_SHOT_CASES) {
    kb.upsert(c);
  }
  // 插入觀察到的真實修正案例
  for (const c of OBSERVED_CASES) {
    kb.upsert(c);
  }

  console.log(`[seed] Total cases: ${kb.count()}`);
  console.log(`[seed] Few-shot: ${kb.list().filter((c) => c.isFewShot).length}`);
  console.log(`[seed] Observed: ${kb.list().filter((c) => !c.isFewShot).length}`);

  // 快速自查：python F401 應找到 1 筆（few-shot 被排除，只剩觀察案例若有）
  const pythonF401 = kb.search({ language: "python", errorType: "F401", topK: 5 });
  console.log(`[self-check] python F401 (excl few-shot): ${pythonF401.length} 筆`);

  const pythonE999 = kb.search({ language: "python", errorType: "E999", topK: 5 });
  console.log(`[self-check] python E999: ${pythonE999.length} 筆`);
  if (pythonE999.length > 0) {
    console.log(`  -> ${pythonE999[0].fixedDiff.slice(0, 120)}...`);
  }

  db.close();
  console.log("[seed] Done.");
}

main();