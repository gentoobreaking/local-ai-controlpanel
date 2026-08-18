// T021 Pi Worker 測試（spec §15/§16）
// 覆蓋：
// - stub 模式（llama.cpp 未啟動）快速路徑
// - §16 contract JSON（evidence 以 evidence 欄位傳遞、無 web search capability 聲明）
// - interrupt 中止進行中的 execute
// - llama 模式（fake endpoint）可呼叫

import { test } from "node:test";
import assert from "node:assert/strict";
import { PiWorker } from "../../src/worker/pi-worker.js";
import { LlamaClient, LlamaConnectionError } from "../../src/worker/llama-client.js";
import type { WorkerContext, WorkerRequest } from "../../src/worker/types.js";
import type { StyleCase } from "../../src/rag/style-kb.js";

function makeRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    task: {
      id: "TASK-001",
      request: "add deployment scaling support",
      status: "IMPLEMENTING",
      complexity: "medium",
      risk: "low",
      sandboxMode: "seatbelt",
      workspace: "/tmp/ws",
      flags: [],
      attempt: 1,
      createdAt: "2026-08-14T00:00:00Z",
      updatedAt: "2026-08-14T00:00:00Z",
    } as WorkerRequest["task"],
    evidence: {
      taskId: "TASK-001",
      facts: [
        { id: "f1", claim: "K8s HPA scales replicas", source: "kubernetes-official", sourceType: "docs", confidence: 0.9, relevance: 0.9 },
        { id: "f2", claim: "deployment.go has replicas field", source: "repository", sourceType: "repo", confidence: 0.8, relevance: 0.7 },
      ],
      constraints: ["do not touch go.mod"],
      versions: [{ package: "k8s.io/api", version: "v0.29" }],
      unresolvedQuestions: [],
      truncated: false,
      droppedFactIds: [],
      estimatedTokens: 100,
    },
    plan: { id: "plan-1", steps: [{ id: "s1", description: "add HPA" }] },
    executionPolicy: {
      strategy: "local_only",
      tier: "local",
      worker: "pi-local",
      model: "qwen2.5-coder:7b",
      allowCloud: false,
      maxAttempts: 3,
      allowedFiles: ["pkg/controller/deployment.go"],
      readonlyFiles: ["go.mod"],
      verification: ["go test ./pkg/controller/..."],
    },
    workspace: { path: "/tmp/ws", languages: ["go"], frameworks: ["k8s"] },
    ...overrides,
  };
}

test("stub 模式：llama.cpp 不可達時走 stub 快速路徑（§16 備註）", async () => {
  const worker = new PiWorker({ allowStub: true });
  await worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
  assert.equal(worker.mode, "stub");

  const res = await worker.execute(makeRequest());
  assert.equal(res.ok, true);
  assert.ok(res.patch!.includes("TASK-001"), "patch 含 task id");
  // stub 模式產生 Python 檔案於 src/ 目錄下
  assert.ok(res.changedFiles.length > 0);
  assert.ok(res.changedFiles[0]!.startsWith("src/") && res.changedFiles[0]!.endsWith("_stub.py"));
  assert.ok(res.summary.includes("2 筆 evidence"), "summary 含 evidence 筆數");
  await worker.shutdown();
});

test("§16 contract：evidence 以 evidence 欄位傳遞，Pi 無 web search 能力", async () => {
  const worker = new PiWorker({ allowStub: true });
  await worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });

  // 從 execute 的 output 驗證 contract 內容有被傳遞
  const res = await worker.execute(makeRequest());
  assert.ok(res.output!.includes("evidence=2"), "stub output 含 evidence 筆數");
  assert.ok(res.output!.includes("allowed=1"), "stub output 含 allowed_files 數");

  // PiWorker 不暴露任何 web/search 方法——介面上只有 initialize/execute/interrupt/shutdown
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(worker));
  assert.ok(!proto.some((m) => /web|search/i.test(m)), "PiWorker 無 web/search 方法");
  await worker.shutdown();
});

test("stub 模式：plan 步驟數傳入 contract", async () => {
  const worker = new PiWorker({ allowStub: true });
  await worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
  const res = await worker.execute(makeRequest({ plan: { id: "p", steps: [{ id: "a", description: "x" }, { id: "b", description: "y" }, { id: "c", description: "z" }] } }));
  assert.ok(res.summary.includes("3 步"), "summary 含 plan 步數");
  await worker.shutdown();
});

test("interrupt：中止進行中的 execute（§15）", async () => {
  const worker = new PiWorker({ allowStub: true });
  await worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });

  // stub 路徑有 50ms 延遲，interrupt 後應回傳中止結果
  const execPromise = worker.execute(makeRequest());
  await worker.interrupt();
  const res = await execPromise;
  assert.equal(res.ok, false);
  assert.equal(res.errorClassification, "tool_error");
  assert.match(res.summary, /interrupted/i);
  await worker.shutdown();
});

test("interrupt：llama 模式中斷進行中的 request", async () => {
  // 起一個「接受連線但永不回應」的 server，讓 chat 掛住
  const server = await startHangingServer();
  try {
    const client = new LlamaClient({ baseUrl: server.url, model: "m", timeoutMs: 30_000 });
    const p = client.chat([{ role: "user", content: "hi" }]);
    // 等 request 送出後 interrupt
    await new Promise((r) => setTimeout(r, 100));
    client.interrupt();
    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof LlamaConnectionError);
      assert.match((err as Error).message, /interrupt/i);
      return true;
    });
  } finally {
    server.close();
  }
});

/** 接受連線但永不回應的 server（讓 fetch 掛住）。 */
async function startHangingServer() {
  const { createServer } = await import("node:http");
  const server = createServer(() => {
    // 不回應——request 永遠掛著
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };
}

test("allowStub=false 且 endpoint 不可達時 initialize 拋錯", async () => {
  const worker = new PiWorker({ allowStub: false });
  await assert.rejects(
    worker.initialize({ baseUrl: "http://127.0.0.1:1", model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" }),
    LlamaConnectionError,
  );
});

test("llama 模式：fake OpenAI-compatible endpoint 可呼叫（§16 設定化 baseUrl + model）", async () => {
  // 起一個假 llama-server（OpenAI-compatible chat completions）
  const server = await startFakeLlama();
  try {
    const worker = new PiWorker({ allowStub: false });
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    assert.equal(worker.mode, "llama");
    const res = await worker.execute(makeRequest());
    assert.equal(res.ok, true);
    assert.ok(res.output!.includes("DONE"), "模型輸出含 DONE");
    const body = server.lastBody();
    assert.ok(body, "lastBody 不為 null");
    assert.ok(body.model === "qwen2.5-coder:7b", "request 帶正確 model 名稱");
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user")!;
    assert.ok(userMsg.content.includes("deployment scaling"), "user prompt 含 objective");
    assert.ok(userMsg.content.includes("kubernetes-official"), "user prompt 含 evidence（§16 contract）");
    assert.ok(!userMsg.content.includes("web"), "user prompt 無 web 相關內容");
    const sysMsg = body.messages.find((m: { role: string }) => m.role === "system")!;
    // T027：system prompt 注入風格規範
    assert.ok(sysMsg.content.includes("風格規範"), "system prompt 含風格規範標題");
    assert.ok(sysMsg.content.includes("import 位置"), "含 import 位置規則");
    assert.ok(sysMsg.content.includes("空行"), "含空行規則");
    assert.ok(sysMsg.content.includes("行長"), "含行長規則");
    assert.ok(sysMsg.content.includes("星號匯入"), "含星號匯入規則");
    assert.ok(sysMsg.content.includes("行尾空白"), "含行尾空白規則");
    assert.ok(sysMsg.content.includes("import 順序"), "含 import 順序規則");
    // T028：system prompt 注入 few-shot 區塊（錯誤 → 修正案例）
    assert.ok(sysMsg.content.includes("Few-shot"), "system prompt 含 few-shot 標記");
    assert.ok(sysMsg.content.includes("錯誤輸出"), "含錯誤輸出標記");
    assert.ok(sysMsg.content.includes("修正後 code diff"), "含修正後 code diff 標記");
    assert.ok(sysMsg.content.includes("F401"), "few-shot 涵蓋 F401（import 位置）");
    assert.ok(sysMsg.content.includes("E302"), "few-shot 涵蓋 E302（空行）");
    assert.ok(sysMsg.content.includes("E501"), "few-shot 涵蓋 E501（行長）");
    assert.ok(sysMsg.content.includes("F403"), "few-shot 涵蓋 F403（星號匯入）");
  } finally {
    server.close();
  }
});

test("llama 模式：fake OpenAI-compatible endpoint 可呼叫（§16 設定化 baseUrl + model）", async () => {
  // 起一個假 llama-server（OpenAI-compatible chat completions）
  const server = await startFakeLlama();
  try {
    const worker = new PiWorker({ allowStub: false });
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    assert.equal(worker.mode, "llama");
    const res = await worker.execute(makeRequest());
    assert.equal(res.ok, true);
    assert.ok(res.output!.includes("DONE"), "模型輸出含 DONE");
    const body = server.lastBody();
    assert.ok(body, "lastBody 不為 null");
    assert.ok(body.model === "qwen2.5-coder:7b", "request 帶正確 model 名稱");
    const userMsg = body.messages.find((m: { role: string }) => m.role === "user")!;
    assert.ok(userMsg.content.includes("deployment scaling"), "user prompt 含 objective");
    assert.ok(userMsg.content.includes("kubernetes-official"), "user prompt 含 evidence（§16 contract）");
    assert.ok(!userMsg.content.includes("web"), "user prompt 無 web 相關內容");
    const sysMsg = body.messages.find((m: { role: string }) => m.role === "system")!;
    // T027：system prompt 注入風格規範
    assert.ok(sysMsg.content.includes("風格規範"), "system prompt 含風格規範標題");
    assert.ok(sysMsg.content.includes("import 位置"), "含 import 位置規則");
    assert.ok(sysMsg.content.includes("空行"), "含空行規則");
    assert.ok(sysMsg.content.includes("行長"), "含行長規則");
    assert.ok(sysMsg.content.includes("星號匯入"), "含星號匯入規則");
    assert.ok(sysMsg.content.includes("行尾空白"), "含行尾空白規則");
    assert.ok(sysMsg.content.includes("import 順序"), "含 import 順序規則");
    // T028：system prompt 注入 few-shot 區塊（錯誤 → 修正案例）
    assert.ok(sysMsg.content.includes("Few-shot"), "system prompt 含 few-shot 標記");
    assert.ok(sysMsg.content.includes("錯誤輸出"), "含錯誤輸出標記");
    assert.ok(sysMsg.content.includes("修正後 code diff"), "含修正後 code diff 標記");
    assert.ok(sysMsg.content.includes("F401"), "few-shot 涵蓋 F401（import 位置）");
    assert.ok(sysMsg.content.includes("E302"), "few-shot 涵蓋 E302（空行）");
    assert.ok(sysMsg.content.includes("E501"), "few-shot 涵蓋 E501（行長）");
    assert.ok(sysMsg.content.includes("F403"), "few-shot 涵蓋 F403（星號匯入）");
  } finally {
    server.close();
  }
});

test("llama 模式：模型回 FAILED 時分類失敗", async () => {
  const server = await startFakeLlama({ reply: "FAILED: cannot find file deployment.go\n" });
  try {
    const worker = new PiWorker({ allowStub: false });
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    const res = await worker.execute(makeRequest());
    assert.equal(res.ok, false);
    assert.equal(res.errorClassification, "coding_error");
  } finally {
    server.close();
  }
});

// ── T029 RAG 區塊測試 ─────────────────────────────────────────────

test("llama 模式：RAG 區塊注入（有檢索結果時）", async () => {
  const server = await startFakeLlama();
  try {
    const mockCases: StyleCase[] = [
      {
        id: "rag-1",
        language: "python",
        errorType: "F401",
        errorSnippet: "def foo():\n    import requests\n    return requests.get('x')",
        fixedDiff: "+import requests\n\ndef foo():\n    return requests.get('x')",
        createdAt: new Date().toISOString(),
      },
      {
        id: "rag-2",
        language: "python",
        errorType: "E302",
        errorSnippet: "import json\n\ndef load():",  // 只 1 空行
        fixedDiff: " import json\n+\n+def load():",
        createdAt: new Date().toISOString(),
      },
    ];
    const retriever = async (): Promise<StyleCase[]> => mockCases;
    const worker = new PiWorker({ allowStub: false, ragRetriever: retriever });
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    const res = await worker.execute(makeRequest());
    const body = server.lastBody();
    assert.ok(body, "lastBody 不為 null");
    const sysMsg = body.messages.find((m: { role: string }) => m.role === "system")!;
    // T029：system prompt 注入 RAG 區塊（最低優先序）
    assert.ok(sysMsg.content.includes("RAG 歷史修正案例"), "system prompt 含 RAG 區塊標題");
    assert.ok(sysMsg.content.includes("F401"), "RAG 案例含 F401");
    assert.ok(sysMsg.content.includes("E302"), "RAG 案例含 E302");
    assert.ok(sysMsg.content.includes("錯誤輸出"), "RAG 含錯誤輸出標記");
    assert.ok(sysMsg.content.includes("修正後 code diff"), "RAG 含修正後 code diff 標記");
    // 順序：風格規範 > few-shot > RAG（最低優先）
    const styleIdx = sysMsg.content.indexOf("風格規範");
    const fewIdx = sysMsg.content.indexOf("Few-shot");
    const ragIdx = sysMsg.content.indexOf("RAG 歷史修正案例");
    assert.ok(styleIdx < fewIdx && fewIdx < ragIdx, "prompt 順序：風格規範 > few-shot > RAG");
  } finally {
    server.close();
  }
});

test("llama 模式：無 RAG retriever 時不注入 RAG 區塊", async () => {
  const server = await startFakeLlama();
  try {
    const worker = new PiWorker({ allowStub: false }); // 無 ragRetriever
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    const res = await worker.execute(makeRequest());
    const body = server.lastBody();
    assert.ok(body, "lastBody 不為 null");
    const sysMsg = body.messages.find((m: { role: string }) => m.role === "system")!;
    assert.ok(!sysMsg.content.includes("RAG 歷史修正案例"), "無 retriever 時不含 RAG 區塊");
  } finally {
    server.close();
  }
});

test("llama 模式：RAG retriever 回傳空陣列時不注入 RAG 區塊", async () => {
  const server = await startFakeLlama();
  try {
    const retriever = async (): Promise<StyleCase[]> => [];
    const worker = new PiWorker({ allowStub: false, ragRetriever: retriever });
    await worker.initialize({ baseUrl: server.url, model: "qwen2.5-coder:7b", workspaceRoot: "/tmp" });
    const res = await worker.execute(makeRequest());
    const body = server.lastBody();
    assert.ok(body, "lastBody 不為 null");
    const sysMsg = body.messages.find((m: { role: string }) => m.role === "system")!;
    assert.ok(!sysMsg.content.includes("RAG 歷史修正案例"), "空結果時不含 RAG 區塊");
  } finally {
    server.close();
  }
});

// ── 測試用 fake llama-server ──────────────────────────────────────────

async function startFakeLlama(opts: { reply?: string } = {}) {
  const { createServer } = await import("node:http");
  let lastBody: {
    model: string;
    messages: Array<{ role: string; content: string }>;
  } | null = null;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: opts.reply ?? "plan:\n- add HPA\n\n```diff\n--- a/pkg/controller/deployment.go\n+++ b/pkg/controller/deployment.go\n@@ -1 +1 @@\n+ scaled\n```\n\nDONE" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    lastBody: () => lastBody,
    close: () => server.close(),
  };
}
