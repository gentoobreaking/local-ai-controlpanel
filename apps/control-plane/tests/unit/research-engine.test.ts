// T037 Research Engine 單元測試

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getMemoryRetriever } from "../../src/memory/retriever.js";
import { StyleKnowledgeBase, ngramVector, cosineSim } from "../../src/rag/style-kb.js";
import { ResearchEngine, createResearchEngine, queryExpansion, computeCredibility, deduplicateEvidence, type EvidenceSource } from "../../src/research/engine.js";

function makeTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
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
  return db;
}

test("queryExpansion: 基本關鍵字擴展", () => {
  const expanded = queryExpansion("lint error");
  assert.ok(expanded.includes("lint error"));
  assert.ok(expanded.includes("linting"));
  assert.ok(expanded.includes("eslint"));
});

test("queryExpansion: 同義詞擴展", () => {
  const expanded = queryExpansion("import error");
  assert.ok(expanded.includes("module"));
  assert.ok(expanded.includes("dependency"));
});

test("queryExpansion: 雙詞組合", () => {
  const expanded = queryExpansion("type error undefined");
  assert.ok(expanded.some((e) => e === "type error"));
  assert.ok(expanded.some((e) => e === "error undefined"));
});

test("ngramVector: 生成向量", () => {
  const v = ngramVector("hello world");
  assert.strictEqual(v.length, 256);
  assert.ok(v.reduce((a, b) => a + b, 0) > 0);
});

test("cosineSim: 相同向量相似度為 1", () => {
  const v = ngramVector("test");
  assert.ok(Math.abs(cosineSim(v, v) - 1) < 1e-5);
});

test("cosineSim: 正交向量相似度較低", () => {
  const v1 = ngramVector("aaa");
  const v2 = ngramVector("bbb");
  assert.ok(cosineSim(v1, v2) < 0.5);
});

test("computeCredibility: memory 類型最高可信度", () => {
  const source: EvidenceSource = { type: "memory", confidence: 0.9, id: "1", title: "", snippet: "", createdAt: "" };
  assert.strictEqual(computeCredibility(source), 0.81);
});

test("computeCredibility: style-kb 類型次之", () => {
  const source: EvidenceSource = { type: "style-kb", confidence: 0.9, id: "1", title: "", snippet: "", createdAt: "" };
  assert.strictEqual(computeCredibility(source), 0.765);
});

test("computeCredibility: external 類型最低", () => {
  const source: EvidenceSource = { type: "external", confidence: 0.9, id: "1", title: "", snippet: "", createdAt: "" };
  assert.strictEqual(computeCredibility(source), 0.63);
});

test("deduplicateEvidence: 去除重複", () => {
  const evidence: EvidenceSource[] = [
    { type: "memory", id: "1", title: "", snippet: "test snippet", confidence: 0.9, createdAt: "" },
    { type: "memory", id: "1", title: "", snippet: "test snippet", confidence: 0.9, createdAt: "" },
    { type: "style-kb", id: "2", title: "", snippet: "different", confidence: 0.8, createdAt: "" },
  ];
  const unique = deduplicateEvidence(evidence);
  assert.strictEqual(unique.length, 2);
});

test("createResearchEngine: 返回實例", () => {
  const engine = createResearchEngine();
  assert.ok(engine instanceof ResearchEngine);
});

test("research: 空查詢返回空結果", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const engine = createResearchEngine({ memoryRetriever, styleKb });

  const result = await engine.research({
    taskId: "test-project-123",
    query: "nonexistent query xyz",
    topK: 5,
  });

  assert.strictEqual(result.taskId, "test-project-123");
  assert.strictEqual(result.query, "nonexistent query xyz");
  assert.strictEqual(result.evidence.length, 0);
  assert.strictEqual(result.confidence, 0);
});

test("research: Memory Retriever 檢索", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const engine = createResearchEngine({ memoryRetriever, styleKb });

  memoryRetriever.storeMemory({
    taskId: "test-project-123",
    project: "test",
    language: "python",
    errorType: "F401",
    fixedDiff: "- import os\n+ import sys",
    tags: ["python", "import"],
  });

  const result = await engine.research({
    taskId: "test-project-123",
    query: "python import error",
    language: "python",
    topK: 5,
  });

  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.some((e) => e.type === "memory"));
  assert.ok(result.confidence > 0);
});

test("research: StyleKB 檢索", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const engine = createResearchEngine({ memoryRetriever, styleKb });

  styleKb.upsert({
    id: "test-case-1",
    language: "typescript",
    errorType: "TS2304",
    errorSnippet: "Cannot find name 'foo'",
    fixedDiff: "+ declare const foo: any;",
    createdAt: new Date().toISOString(),
  });

  const result = await engine.research({
    taskId: "test-project-123",
    query: "typescript cannot find name",
    language: "typescript",
    topK: 5,
  });

  assert.ok(result.evidence.length > 0);
  assert.ok(result.evidence.some((e) => e.type === "style-kb"));
});

test("research: 混合檢索 + 去重", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const engine = createResearchEngine({ memoryRetriever, styleKb });

  memoryRetriever.storeMemory({
    taskId: "test-project-123",
    project: "test",
    language: "python",
    errorType: "F401",
    fixedDiff: "- import os\n+ import sys",
    tags: ["python", "import"],
  });

  styleKb.upsert({
    id: "test-case-2",
    language: "python",
    errorType: "F401",
    errorSnippet: "import os unused",
    fixedDiff: "- import os",
    createdAt: new Date().toISOString(),
  });

  const result = await engine.research({
    taskId: "test-project-123",
    query: "python unused import",
    language: "python",
    topK: 5,
  });

  assert.ok(result.evidence.length >= 1);
  const types = new Set(result.evidence.map((e) => e.type));
  assert.ok(types.size >= 1);
});

test("createResearchEngine: 支援外部搜尋", async () => {
  const externalSearch = async (): Promise<EvidenceSource[]> => [
    { type: "external", id: "ext-1", title: "External", snippet: "result", confidence: 0.7, createdAt: new Date().toISOString() },
  ];
  const engine = createResearchEngine({ externalSearch });

  const result = await engine.research({
    taskId: "test-123",
    query: "external search test",
    topK: 5,
  });

  assert.ok(result.evidence.some((e) => e.type === "external"));
});