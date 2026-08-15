#!/usr/bin/env npx tsx
/**
 * T029 RAG A/B 驗證腳本
 * 對照：T028 prompt (style+few-shot) vs T029 (style+few-shot+RAG)
 * 任務：Python requests (同 T028 Phase C)
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { PiWorker } from "../apps/control-plane/src/worker/pi-worker.js";
import type { PiContract, StyleCase } from "../apps/control-plane/src/rag/style-kb.js";
import {
  StyleKnowledgeBase,
  createStyleKbRetriever,
} from "../apps/control-plane/src/rag/style-kb.js";

const KB_PATH = resolve("apps/control-plane/.style-kb.db");
const db = new DatabaseSync(KB_PATH);
const kb = new StyleKnowledgeBase(db);

// 建立 retriever：語言 python，錯誤類型從 previous_feedback 抽取
const retriever = createStyleKbRetriever(kb, { language: () => "python" });

async function runTask(useRag: boolean, taskId: string): Promise<{
  success: boolean;
  attempts: number;
  lintFail: boolean;
  firstVerifiedAttemptLintPass: boolean;
}> {
  const worker = new PiWorker({
    allowStub: false,
    ragRetriever: useRag ? retriever : undefined,
    llamaTimeoutMs: 300_000,
    llamaMaxTokens: 800,
  });
  await worker.initialize({
    baseUrl: "http://127.0.0.1:11434",
    model: "robit/ornith:9b",
    workspaceRoot: "/tmp",
  });

  const req = makeRequest(taskId);
  const res = await worker.execute(req);
  await worker.shutdown();

  // 解析結果
  const firstVerifiedAttemptLintPass = res.ok && !res.patch?.includes("E999");
  return {
    success: res.ok,
    attempts: res.attempts || 1,
    lintFail: !res.ok || (res.output?.includes("lint=FAIL") ?? false),
    firstVerifiedAttemptLintPass,
  };
}

function makeRequest(taskId: string) {
  return {
    task: {
      id: taskId,
      request:
        "Add a function and tests using an external library whose current API must be researched. " +
        "Implement get_status_code(url) in src/api_client.py that does a GET request with the requests " +
        "library and returns the HTTP status code. The repository already provides tests in " +
        "tests/test_api_client.py as the acceptance criteria — do NOT modify it; extra tests go in new files like tests/test_extra.py.",
      status: "IMPLEMENTING",
      complexity: "medium",
      risk: "low",
      sandboxMode: "seatbelt",
      workspace: "/tmp",
      flags: [],
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any,
    evidence: {
      taskId,
      facts: [
        { id: "f1", claim: "requests.get(url) 回傳 Response 物件；HTTP 狀態碼在 response.status_code 屬性（int）。", source: "requests-official", sourceType: "docs", confidence: 0.9, relevance: 0.9 },
        { id: "f2", claim: "requests library 需先 `import requests`；get() 需傳完整 URL 字串，可用 timeout 參數。", source: "requests-quickstart", sourceType: "docs", confidence: 0.85, relevance: 0.7 },
        { id: "f3", claim: "repo 測試慣例：tests/test_api_client.py 使用 monkeypatch 替換 requests.get（現有 FakeResponse fixture，驗證 sandbox 無網路）——新增測試應沿用此慣例。", source: "pytest-monkeypatch", sourceType: "docs", confidence: 0.7, relevance: 0.6 },
      ],
      constraints: [],
      versions: [{ package: "requests", version: "2.31" }],
      unresolvedQuestions: [],
      truncated: false,
      droppedFactIds: [],
      estimatedTokens: 150,
    },
    plan: { id: "plan-1", steps: [{ id: "s1", description: "add get_status_code" }] },
    executionPolicy: {
      strategy: "local_only",
      tier: "local",
      worker: "pi-local",
      model: "robit/ornith:9b",
      allowCloud: false,
      maxAttempts: 3,
      allowedFiles: ["src/api_client.py"],
      readonlyFiles: ["tests/test_api_client.py"],
      verification: ["python3 -m pytest -q", "python3 -m ruff check ."],
    },
    workspace: { path: "/tmp", languages: ["python"], frameworks: ["requests"] },
  };
}

async function main() {
  console.log("=== T029 RAG A/B 驗證 ===");
  console.log("Control: T028 (style+few-shot, no RAG)");
  console.log("Treatment: T029 (style+few-shot+RAG with E999 case)");
  console.log("KB cases: python E999 x1 (from T028 observed failures)\n");

  const N = 3;
  const results: Record<string, any[]> = { control: [], treatment: [] };

  for (let i = 1; i <= N; i++) {
    const tid = `T029-AB-${i}`;
    console.log(`\n--- Run ${i}/${N} ---`);

    // Control (no RAG)
    const c = await runTask(false, tid + "-C");
    results.control.push(c);
    console.log(`Control: success=${c.success} attempts=${c.attempts} lintFail=${c.lintFail} firstLintPass=${c.firstVerifiedAttemptLintPass}`);

    // Treatment (with RAG)
    const t = await runTask(true, tid + "-T");
    results.treatment.push(t);
    console.log(`Treatment: success=${t.success} attempts=${t.attempts} lintFail=${t.lintFail} firstLintPass=${t.firstVerifiedAttemptLintPass}`);
  }

  // 統計
  const cLf = results.control.filter((r) => r.lintFail).length;
  const tLf = results.treatment.filter((r) => r.lintFail).length;
  const cFp = results.control.filter((r) => r.firstVerifiedAttemptLintPass).length;
  const tFp = results.treatment.filter((r) => r.firstVerifiedAttemptLintPass).length;

  console.log("\n=== 統計 ===");
  console.log(`Control (n=${N}): lint=FAIL ${cLf}/${N} (${(cLf/N*100).toFixed(0)}%), first-attempt lint=PASS ${cFp}/${N} (${(cFp/N*100).toFixed(0)}%)`);
  console.log(`Treatment (n=${N}): lint=FAIL ${tLf}/${N} (${(tLf/N*100).toFixed(0)}%), first-attempt lint=PASS ${tFp}/${N} (${(tFp/N*100).toFixed(0)}%)`);
  const lintDrop = ((cLf/N) - (tLf/N)) / (cLf/N) * 100;
  const firstPassGain = ((tFp/N) - (cFp/N)) / (cFp/N) * 100;
  console.log(`lint=FAIL 相對下降: ${lintDrop.toFixed(0)}%`);
  console.log(`first-attempt lint=PASS 相對提升: ${firstPassGain.toFixed(0)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });