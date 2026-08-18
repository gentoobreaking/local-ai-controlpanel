// T038 Evidence Model 單元測試

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getMemoryRetriever } from "../../src/memory/retriever.js";
import { StyleKnowledgeBase } from "../../src/rag/style-kb.js";
import { createResearchEngine } from "../../src/research/engine.js";
import { VerificationEngine } from "../../src/verification/engine.js";
import { createDefaultRegistry } from "../../src/sandbox/registry.js";
import { createEvidenceModel, computeCredibility, computeTimeliness, computeWeightedScore, deduplicateEvidence } from "../../src/evidence/model.js";
import { DEFAULT_EVIDENCE_WEIGHTS, EVIDENCE_PASS_THRESHOLD } from "../../src/evidence/types.js";

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

    CREATE TABLE IF NOT EXISTS verification_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      verifier TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT,
      sandbox_mode TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

test("DEFAULT_EVIDENCE_WEIGHTS: 所有類型都有權重", () => {
  assert.ok(DEFAULT_EVIDENCE_WEIGHTS.documentation > 0);
  assert.ok(DEFAULT_EVIDENCE_WEIGHTS.code_execution > 0);
  assert.ok(DEFAULT_EVIDENCE_WEIGHTS.external_api > 0);
  assert.ok(DEFAULT_EVIDENCE_WEIGHTS.memory > 0);
  assert.ok(DEFAULT_EVIDENCE_WEIGHTS.style_kb > 0);
});

test("EVIDENCE_PASS_THRESHOLD: 門檻為 0.7", () => {
  assert.strictEqual(EVIDENCE_PASS_THRESHOLD, 0.7);
});

test("computeCredibility: documentation 類型最高可信度", () => {
  const source = {
    type: "documentation",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.5,
    relevance: 0.5,
    timeliness: 0.5,
    score: 0,
    accessedAt: "",
  } as any;
  const cred = computeCredibility(source);
  assert.ok(cred >= 0.9 && cred <= 1.0);
});

test("computeCredibility: code_execution 類型完全可信", () => {
  const source = {
    type: "code_execution",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.5,
    relevance: 0.5,
    timeliness: 0.5,
    score: 0,
    accessedAt: "",
  } as any;
  const cred = computeCredibility(source);
  assert.strictEqual(cred, 1.0);
});

test("computeCredibility: external_api 類型較低", () => {
  const source = {
    type: "external_api",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.5,
    relevance: 0.5,
    timeliness: 0.5,
    score: 0,
    accessedAt: "",
  } as any;
  const cred = computeCredibility(source);
  assert.ok(cred >= 0.7 && cred <= 0.8);
});

test("computeCredibility: memory 類型次之", () => {
  const source = {
    type: "memory",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.5,
    relevance: 0.5,
    timeliness: 0.5,
    score: 0,
    accessedAt: "",
  } as any;
  const cred = computeCredibility(source);
  assert.ok(cred >= 0.8 && cred <= 0.9);
});

test("computeCredibility: style_kb 類型", () => {
  const source = {
    type: "style_kb",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.5,
    relevance: 0.5,
    timeliness: 0.5,
    score: 0,
    accessedAt: "",
  } as any;
  const cred = computeCredibility(source);
  assert.ok(cred >= 0.85 && cred <= 0.95);
});

test("computeTimeliness: 7天內為 1.0", () => {
  const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(computeTimeliness(recent), 1.0);
});

test("computeTimeliness: 30天內為 0.8", () => {
  const recent = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(computeTimeliness(recent), 0.8);
});

test("computeTimeliness: 90天內為 0.5", () => {
  const recent = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(computeTimeliness(recent), 0.5);
});

test("computeTimeliness: 無時間返回 0.5", () => {
  assert.strictEqual(computeTimeliness(undefined), 0.5);
});

test("computeWeightedScore: 計算加權分數", () => {
  const source = {
    type: "documentation",
    id: "1",
    title: "",
    snippet: "",
    credibility: 0.9,
    relevance: 0.8,
    timeliness: 1.0,
    score: 0,
    accessedAt: "",
  } as any;

  const weights = {
    documentation: 1.0,
    code_execution: 1.0,
    external_api: 0.8,
    memory: 0.9,
    style_kb: 0.85,
  };

  const score = computeWeightedScore(source, weights);
  // (0.9 * 0.4 + 0.8 * 0.4 + 1.0 * 0.2) * 1.0 = 0.36 + 0.32 + 0.2 = 0.88
  assert.ok(score >= 0.8 && score <= 1.0);
});

test("deduplicateEvidence: 去除重複證據", () => {
  const evidence = [
    {
      type: "documentation" as const,
      id: "1",
      title: "",
      snippet: "test snippet",
      credibility: 0.9,
      relevance: 0.8,
      timeliness: 1.0,
      score: 0.85,
      accessedAt: "",
    },
    {
      type: "documentation" as const,
      id: "1",
      title: "",
      snippet: "test snippet",
      credibility: 0.9,
      relevance: 0.8,
      timeliness: 1.0,
      score: 0.85,
      accessedAt: "",
    },
    {
      type: "code_execution" as const,
      id: "2",
      title: "",
      snippet: "different snippet",
      credibility: 1.0,
      relevance: 0.9,
      timeliness: 1.0,
      score: 0.95,
      accessedAt: "",
    },
  ];

  const unique = deduplicateEvidence(evidence);
  assert.strictEqual(unique.length, 2);
});

test("createEvidenceModel: 返回實例", () => {
  const model = createEvidenceModel();
  assert.ok(model instanceof Object);
});

test("evidenceModel: createEvidenceFromVerification", () => {
  const model = createEvidenceModel();
  const evidence = model.createEvidenceFromVerification(
    "task-123",
    "eslint",
    "PASS",
    "No lint errors found",
    100,
  );

  assert.strictEqual(evidence.type, "code_execution");
  assert.ok(evidence.id.includes("task-123"));
  assert.ok(evidence.id.includes("eslint"));
  assert.strictEqual(evidence.credibility, 1.0);
  assert.strictEqual(evidence.relevance, 1.0);
  assert.strictEqual(evidence.metadata?.verifier, "eslint");
  assert.strictEqual(evidence.metadata?.status, "PASS");
});

test("evidenceModel: createEvidenceFromDocumentation", () => {
  const model = createEvidenceModel();
  const evidence = model.createEvidenceFromDocumentation(
    "doc-1",
    "Python Style Guide",
    "https://peps.python.org/pep-0008/",
    "Use 4 spaces per indentation level",
    "Full content here...",
    true,
  );

  assert.strictEqual(evidence.type, "documentation");
  assert.strictEqual(evidence.title, "Python Style Guide");
  assert.strictEqual(evidence.url, "https://peps.python.org/pep-0008/");
  assert.ok(evidence.credibility >= 0.95);
  assert.strictEqual(evidence.metadata?.official, true);
});

test("evidenceModel: createEvidenceFromExternalApi", () => {
  const model = createEvidenceModel();
  const evidence = model.createEvidenceFromExternalApi(
    "api-1",
    "StackOverflow Answer",
    "https://stackoverflow.com/a/12345",
    "Use list comprehension instead of map",
    "Full answer...",
  );

  assert.strictEqual(evidence.type, "external_api");
  assert.strictEqual(evidence.url, "https://stackoverflow.com/a/12345");
  assert.ok(evidence.credibility <= 0.75);
  assert.ok(evidence.timeliness >= 0.8);
});

test("evidenceModel: getWeights / updateWeights", () => {
  const model = createEvidenceModel({ weights: { documentation: 0.5 } });
  const weights = model.getWeights();
  assert.strictEqual(weights.documentation, 0.5);

  model.updateWeights({ documentation: 1.5, code_execution: 0.8 });
  const newWeights = model.getWeights();
  assert.strictEqual(newWeights.documentation, 1.5);
  assert.strictEqual(newWeights.code_execution, 0.8);
});

test("evidenceModel: collectEvidence 基本功能", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const researchEngine = createResearchEngine({ memoryRetriever, styleKb });
  const registry = createDefaultRegistry({ seatbeltProfile: "" });
  const verificationEngine = new VerificationEngine({
    registry,
    policy: { securityLevel: "medium" },
    record: () => {},
  });

  const model = createEvidenceModel();
  model.setResearchEngine(researchEngine);
  model.setVerificationEngine(verificationEngine);

  const result = await model.collectEvidence({
    taskId: "test-project-123",
    query: "python import error",
    maxResults: 5,
  });

  assert.strictEqual(result.taskId, "test-project-123");
  assert.strictEqual(result.query, "python import error");
  assert.ok(Array.isArray(result.evidence));
  assert.ok(typeof result.totalScore === "number");
  assert.ok(typeof result.passed === "boolean");
  assert.ok(result.timestamp);
});

test("evidenceModel: collectEvidence 空查詢", async () => {
  const model = createEvidenceModel();

  const result = await model.collectEvidence({
    taskId: "test-project-123",
    query: "nonexistent query xyz",
    maxResults: 5,
  });

  assert.strictEqual(result.evidence.length, 0);
  assert.strictEqual(result.totalScore, 0);
  assert.strictEqual(result.passed, false);
});

test("evidenceModel: collectEvidence 類型過濾", async () => {
  const db = makeTestDb();
  const memoryRetriever = getMemoryRetriever(":memory:");
  const styleKb = new StyleKnowledgeBase(db);
  const researchEngine = createResearchEngine({ memoryRetriever, styleKb });
  const registry = createDefaultRegistry({ seatbeltProfile: "" });
  const verificationEngine = new VerificationEngine({
    registry,
    policy: { securityLevel: "medium" },
    record: () => {},
  });

  const model = createEvidenceModel();
  model.setResearchEngine(researchEngine);
  model.setVerificationEngine(verificationEngine);

  // 只查詢 memory 類型
  const result = await model.collectEvidence({
    taskId: "test-project-123",
    query: "python import error",
    types: ["memory"],
    maxResults: 5,
  });

  for (const e of result.evidence) {
    assert.strictEqual(e.type, "memory");
  }
});

test("evidenceModel: collectEvidence 最小分數過濾", async () => {
  const model = createEvidenceModel();

  const result = await model.collectEvidence({
    taskId: "test-project-123",
    query: "test query",
    minScore: 0.9, // 很高的門檻
    maxResults: 5,
  });

  // 應該過濾掉所有低分證據
  assert.ok(result.evidence.every((e) => e.score >= 0.9));
});