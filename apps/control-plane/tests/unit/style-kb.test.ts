// T029 StyleKnowledgeBase 單元測試

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  StyleKnowledgeBase,
  ngramVector,
  cosineSim,
  createStyleKbRetriever,
  detectLanguageFromContract,
  extractErrorTypes,
  VECTOR_DIM,
} from "../../src/rag/style-kb.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function makeCase(overrides: Partial<Parameters<typeof StyleKnowledgeBase.prototype.upsert>[0]> = {}): Parameters<typeof StyleKnowledgeBase.prototype.upsert>[0] {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    language: "python",
    errorType: "F401",
    errorSnippet: "def foo():\n    import requests\n    return requests.get('x')",
    fixedDiff: "+import requests\n\ndef foo():\n    return requests.get('x')",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("ngramVector：相同文字產出相同向量；空字串非全零", () => {
  const v1 = ngramVector("abc def");
  const v2 = ngramVector("abc def");
  assert.deepEqual(Array.from(v1), Array.from(v2), "向量一致");
  const vEmpty = ngramVector("");
  const sum = vEmpty.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0, "空字串向量非全零");
  assert.equal(v1.length, VECTOR_DIM, `維度 ${VECTOR_DIM}`);
});

test("cosineSim：相同向量=1；正交≈0", () => {
  const v = ngramVector("hello world");
  assert.equal(cosineSim(v, v), 1, "自相似=1");
  const a = ngramVector("aaa bbb");
  const b = ngramVector("ccc ddd");
  const sim = cosineSim(a, b);
  assert.ok(sim < 0.5, `不同文本相似度較低: ${sim}`);
});

test("StyleKnowledgeBase：upsert + search 基本", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  const c = makeCase();
  kb.upsert(c);
  assert.equal(kb.count(), 1);
  const res = kb.search({ language: "python", errorType: "F401", snippet: "import requests", topK: 5 });
  assert.equal(res.length, 1);
  const r0 = res[0];
  assert.ok(r0);
  assert.equal(r0.id, c.id);
  assert.equal(r0.errorType, "F401");
});

test("StyleKnowledgeBase：語言過濾", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  kb.upsert(makeCase({ id: "py-1", language: "python", errorType: "F401", errorSnippet: "..." }));
  kb.upsert(makeCase({ id: "go-1", language: "go", errorType: "F401", errorSnippet: "..." }));
  const py = kb.search({ language: "python", topK: 10 });
  const go = kb.search({ language: "go", topK: 10 });
  assert.equal(py.length, 1, "僅找到 python");
  assert.equal(go.length, 1, "僅找到 go");
  assert.ok(py[0]);
  assert.ok(go[0]);
});

test("StyleKnowledgeBase：錯誤類型過濾", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  kb.upsert(makeCase({ id: "f401", language: "python", errorType: "F401", errorSnippet: "..." }));
  kb.upsert(makeCase({ id: "e302", language: "python", errorType: "E302", errorSnippet: "..." }));
  const f401 = kb.search({ language: "python", errorType: "F401", topK: 10 });
  const e302 = kb.search({ language: "python", errorType: "E302", topK: 10 });
  assert.equal(f401.length, 1);
  assert.equal(e302.length, 1);
  const f0 = f401[0];
  const e0 = e302[0];
  assert.ok(f0);
  assert.ok(e0);
  assert.equal(f0.errorType, "F401");
  assert.equal(e0.errorType, "E302");
});

test("StyleKnowledgeBase：最近 30 天過濾", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  kb.upsert(makeCase({ id: "old", language: "python", errorType: "F401", createdAt: old }));
  kb.upsert(makeCase({ id: "new", language: "python", errorType: "F401" }));
  const recent = kb.search({ language: "python", errorType: "F401", maxAgeDays: 30, topK: 10 });
  assert.equal(recent.length, 1, "僅保留 30 天內");
  const r0 = recent[0];
  assert.ok(r0);
  assert.equal(r0.id, "new");
});

test("StyleKnowledgeBase：few-shot 案例永不進入檢索", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  kb.upsert(makeCase({ id: "fs", language: "python", errorType: "F401", isFewShot: true }));
  kb.upsert(makeCase({ id: "norm", language: "python", errorType: "F401" }));
  const res = kb.search({ language: "python", errorType: "F401", topK: 10 });
  assert.equal(res.length, 1, "few-shot 已排除");
  const r0 = res[0];
  assert.ok(r0);
  assert.equal(r0.id, "norm");
});

test("detectLanguageFromContract：以 allowed_files 副檔名計數", () => {
  const lang = detectLanguageFromContract({
    task_id: "T1",
    objective: "x",
    evidence: [],
    allowed_files: ["src/main.py", "src/utils.py", "tests/test_x.py"],
    readonly_files: [],
    verification: [],
  });
  assert.equal(lang, "python");
});

test("extractErrorTypes：從輸出抽取 lint 代碼", () => {
  const types = extractErrorTypes("src/foo.py:5: F401 'requests' imported but unused\nsrc/bar.py:10: E302 expected 2 blank lines");
  assert.ok(types.includes("F401"));
  assert.ok(types.includes("E302"));
  assert.ok(!types.includes("E999")); // 我們的過濾只保留常見前綴
});

test("createStyleKbRetriever：檢索函式語言解析 + 錯誤類型", () => {
  const kb = new StyleKnowledgeBase(makeDb());
  kb.upsert(makeCase({ id: "case1", language: "python", errorType: "F401", errorSnippet: "import requests in function", createdAt: new Date().toISOString() }));
  kb.upsert(makeCase({ id: "case2", language: "go", errorType: "F401", errorSnippet: "unused import", createdAt: new Date().toISOString() }));
  const retriever = createStyleKbRetriever(kb, { language: () => "python" });
  const c = {
    task_id: "T1",
    objective: "x",
    evidence: [],
    allowed_files: ["src/main.py"],
    readonly_files: [],
    verification: [],
    previous_feedback: "F401 'requests' imported but unused in function foo",
  };
  const res = retriever(c);
  assert.ok(res.length >= 1);
  const r0 = res[0];
  assert.ok(r0);
  assert.equal(r0.language, "python");
  assert.equal(r0.errorType, "F401");
});